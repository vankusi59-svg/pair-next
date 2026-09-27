/**
 * Layer C extraction — deterministic canonical-evidence → CANDIDATE pipeline.
 *
 * Every extractor reads Layer-B canonical entities (executions, route/routeing
 * decisions, plans, probe receipts) and produces experience CANDIDATEs only.
 * Nothing here creates QUALIFIED/ACTIVE — promotion is the verifier's job.
 *
 * Aggregation: each candidate family carries a stable `series_key` derived
 * from normalized semantics (never timestamps/ids). Equivalent observations
 * fold into the same series member; dedup is by canonical evidence ref, so
 * replayed evidence is a semantic no-op (no double counting).
 */

import { digest, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { ExperienceService } from "./experience.js";
import type { PairControlPlane } from "./service.js";

export const EXTRACTION_ACTOR = "PAIR_EXPERIENCE_EXTRACTION";

/** Strip volatile data (hex ids, uuids, digits, paths, ISO times) — stable signature. */
export function normalizeErrorSignature(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, "<uuid>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b/g, "<hex>")
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}[\d.:z+-]*/g, "<ts>")
    .replace(/(?:[a-z]:)?[\\/][\w./\\-]+/g, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compatibility fingerprint — sorted stable keys only. */
export function environmentFingerprint(env: Record<string, unknown>): string {
  return digest({ environment: env });
}

function ref(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

export interface ExtractedObservation {
  type: string;
  seriesKey: string;
  evidenceRef: string;
  origin: string;
  scope: Record<string, unknown>;
  payload: Record<string, unknown>;
  outcome?: string;
  confidence?: number;
  minSupport?: number;
  staleAfter?: string;
  environments?: string[];
  executors?: string[];
  providers?: string[];
  models?: string[];
  provenance: string;
}

export class ExperienceExtractor {
  constructor(
    private readonly service: PairControlPlane,
    private readonly experience: ExperienceService,
  ) {}

  private get store() {
    return this.service.store;
  }

  /**
   * Create or fold a candidate. Same series_key + new evidence → aggregate;
   * already-recorded evidence ref → semantic no-op; MODEL_GENERATED origin →
   * created then auto-quarantined by the service (never advisory).
   */
  fold(obs: ExtractedObservation): Record<string, unknown> {
    const existing = this.experience.findBySeriesKey(obs.seriesKey);
    if (existing) {
      return this.experience.foldObservation(String(existing.experience_id), {
        evidence_ref: obs.evidenceRef,
        outcome: obs.outcome,
        environments: obs.environments,
        executors: obs.executors,
        providers: obs.providers,
        models: obs.models,
      });
    }
    return this.experience.createCandidate({
      type: obs.type,
      source_evidence_refs: [obs.evidenceRef],
      provenance: obs.provenance,
      compatibility_scope: obs.scope,
      confidence: obs.confidence,
      payload: obs.payload,
      series_key: obs.seriesKey,
      evidence_origin: obs.origin,
      extracted_by: EXTRACTION_ACTOR,
      min_support: obs.minSupport,
      stale_after: obs.staleAfter,
      outcome: obs.outcome,
      observed_environments: obs.environments,
      observed_executors: obs.executors,
      observed_providers: obs.providers,
      observed_models: obs.models,
    });
  }

  /**
   * Terminal executor execution → EXECUTOR_OBSERVATION (+ FAILURE_SIGNATURE on
   * failure; + PROVIDER_MODEL_OBSERVATION when the execution carries
   * provider/model metadata; + ROUTING_PRIOR when bound to a route_decision).
   */
  fromExecution(
    executionId: string,
    opts: {
      origin: string;
      environment?: Record<string, unknown>;
      minSupport?: number;
    },
  ): Record<string, unknown>[] {
    const exec = this.store.get("executor_execution", executionId);
    const executorId = String(exec.executor_id);
    const terminal = String(exec.result_state ?? exec.execution_state ?? "");
    const outcome = terminal === "COMPLETED" ? "SUCCESS" : "FAILURE";
    const task = this.store.tryGet("task", String(exec.task_id));
    const capabilities =
      ((task?.required_capabilities as string[]) ?? []).map(String).sort();
    const envFp = environmentFingerprint(opts.environment ?? {});
    const envs = opts.environment ? [envFp] : [];
    const out: Record<string, unknown>[] = [];

    out.push(
      this.fold({
        type: "EXECUTOR_OBSERVATION",
        seriesKey: digest({
          type: "EXECUTOR_OBSERVATION",
          executor: executorId,
          capabilities,
          outcome,
          env: envFp,
        }),
        evidenceRef: ref("executor_execution", executionId),
        origin: opts.origin,
        scope: {
          executors: [executorId],
          capabilities,
          environment: opts.environment ?? {},
        },
        payload: {
          executor_id: executorId,
          capabilities,
          outcome,
          environment_fingerprint: envFp,
        },
        outcome,
        minSupport: opts.minSupport,
        environments: envs,
        executors: [executorId],
        provenance: "terminal_execution",
      }),
    );

    if (outcome === "FAILURE") {
      out.push(this.failureSignature(executionId, opts));
    }

    // Provider/model observation — only when the execution actually recorded
    // provider/model context (never inferred).
    const provider = exec.provider_id ?? exec.provider;
    const model = exec.model_id ?? exec.model;
    if (provider || model) {
      out.push(
        this.fold({
          type: "PROVIDER_MODEL_OBSERVATION",
          seriesKey: digest({
            type: "PROVIDER_MODEL_OBSERVATION",
            provider: String(provider ?? null),
            model: String(model ?? null),
            executor: executorId,
            outcome,
            env: envFp,
          }),
          evidenceRef: ref("executor_execution", executionId),
          origin: opts.origin,
          scope: {
            provider: provider ? String(provider) : undefined,
            model: model ? String(model) : undefined,
            executors: [executorId],
            capabilities,
            environment: opts.environment ?? {},
          },
          payload: {
            provider_id: provider ?? null,
            model_id: model ?? null,
            executor_id: executorId,
            outcome,
          },
          outcome,
          environments: envs,
          executors: [executorId],
          providers: provider ? [String(provider)] : [],
          models: model ? [String(model)] : [],
          provenance: "terminal_execution",
        }),
      );
    }

    // ROUTING_PRIOR — the bound route decision is canonical evidence of
    // "this route/executor served this capability with this outcome".
    const routeDecisionId =
      (exec.route_decision_id as string | undefined) ??
      (task?.route_decision_id as string | undefined);
    if (routeDecisionId && this.store.tryGet("route_decision", routeDecisionId)) {
      out.push(
        this.fold({
          type: "ROUTING_PRIOR",
          seriesKey: digest({
            type: "ROUTING_PRIOR",
            executor: executorId,
            capabilities,
            outcome,
            env: envFp,
          }),
          evidenceRef: ref("route_decision", routeDecisionId),
          origin: opts.origin,
          scope: {
            executors: [executorId],
            capabilities,
            environment: opts.environment ?? {},
          },
          payload: {
            executor_id: executorId,
            route_decision_id: routeDecisionId,
            capabilities,
            outcome,
          },
          outcome,
          minSupport: opts.minSupport ?? 2,
          environments: envs,
          executors: [executorId],
          provenance: "route_outcome",
        }),
      );
    }
    return out;
  }

  /** Normalized failure signature — no volatile ids/timestamps/paths. */
  failureSignature(
    executionId: string,
    opts: { origin: string; environment?: Record<string, unknown> },
  ): Record<string, unknown> {
    const exec = this.store.get("executor_execution", executionId);
    const executorId = String(exec.executor_id);
    const task = this.store.tryGet("task", String(exec.task_id));
    const capabilities =
      ((task?.required_capabilities as string[]) ?? []).map(String).sort();
    const result = (exec.result as Record<string, unknown>) ?? {};
    const err = (result.error as Record<string, unknown>) ?? {};
    const errorClass = normalizeErrorSignature(
      String(err.class ?? err.message ?? exec.result_state ?? "UNKNOWN"),
    );
    const envFp = environmentFingerprint(opts.environment ?? {});
    const signature = digest({
      error_class: errorClass,
      executor: executorId,
      capabilities,
      transport: String(result.transport ?? ""),
      env: envFp,
    });
    return this.fold({
      type: "FAILURE_SIGNATURE",
      seriesKey: digest({ type: "FAILURE_SIGNATURE", signature }),
      evidenceRef: ref("executor_execution", executionId),
      origin: opts.origin,
      scope: {
        executors: [executorId],
        capabilities,
        environment: opts.environment ?? {},
      },
      payload: {
        signature,
        error_class: errorClass,
        executor_id: executorId,
        capabilities,
        environment_fingerprint: envFp,
      },
      outcome: "FAILURE",
      environments: opts.environment ? [envFp] : [],
      executors: [executorId],
      provenance: "terminal_failure",
    });
  }

  /**
   * failure F → remediation R → verified rerun success. Both executions must
   * exist canonically, the rerun must be terminal COMPLETED, and both must
   * share the same normalized signature context (same executor+capability).
   */
  remediationPair(
    failureExecutionId: string,
    remediationExecutionId: string,
    opts: { origin: string; remediation: string; environment?: Record<string, unknown> },
  ): Record<string, unknown> {
    const fail = this.store.get("executor_execution", failureExecutionId);
    const ok = this.store.get("executor_execution", remediationExecutionId);
    if (String(ok.result_state ?? ok.execution_state) !== "COMPLETED") {
      throw new IntegrityError(
        "FAIL_CLOSED_REMEDIATION_NOT_VERIFIED",
        remediationExecutionId,
      );
    }
    if (String(fail.executor_id) !== String(ok.executor_id)) {
      throw new IntegrityError(
        "FAIL_CLOSED_REMEDIATION_EXECUTOR_MISMATCH",
        `${fail.executor_id}!=${ok.executor_id}`,
      );
    }
    const envFp = environmentFingerprint(opts.environment ?? {});
    const seriesKey = digest({
      type: "REMEDIATION_PAIR",
      executor: String(fail.executor_id),
      remediation: normalizeErrorSignature(opts.remediation),
    });
    return this.fold({
      type: "REMEDIATION_PAIR",
      seriesKey,
      evidenceRef: ref("executor_execution", remediationExecutionId),
      origin: opts.origin,
      scope: {
        executors: [String(fail.executor_id)],
        environment: opts.environment ?? {},
      },
      payload: {
        failure_execution_id: failureExecutionId,
        remediation_execution_id: remediationExecutionId,
        remediation: opts.remediation,
        executor_id: fail.executor_id,
      },
      outcome: "SUCCESS",
      environments: opts.environment ? [envFp] : [],
      executors: [String(fail.executor_id)],
      provenance: "verified_remediation",
    });
  }

  /**
   * A completed plan revision → PLAN_TEMPLATE. The payload is the task
   * skeleton only — no permissions, executors, workspaces, or ids from the
   * old plan may carry over (reuse re-binds everything).
   */
  planTemplate(
    missionId: string,
    revision: number,
    opts: { origin: string },
  ): Record<string, unknown> {
    const rev = this.store
      .planRevisions(missionId)
      .find((r) => Number(r.revision) === revision);
    if (!rev) {
      throw new IntegrityError("FAIL_CLOSED_PLAN_REVISION_MISSING", String(revision));
    }
    const tasks = this.service
      .listTasks(missionId)
      .filter((t) => String(t.plan_id) === String(rev.plan_id))
      .map((t) => ({
        task_key: String(t.task_key),
        title: String(t.title),
        required_capabilities: t.required_capabilities,
        depends_on: t.depends_on,
      }));
    const seriesKey = digest({ type: "PLAN_TEMPLATE", tasks });
    return this.fold({
      type: "PLAN_TEMPLATE",
      seriesKey,
      evidenceRef: `plan:${String(rev.plan_id)}`,
      origin: opts.origin,
      scope: { plan_shape: seriesKey },
      payload: {
        tasks,
        source_mission_id: missionId,
        source_revision: revision,
      },
      outcome: "SUCCESS",
      provenance: "verified_plan_revision",
    });
  }
}
