/**
 * P9 MissionRuntime — the restart-safe long-running mission execution loop.
 *
 * The runtime ORCHESTRATES existing authorities; it never becomes one:
 *   - Automaton planner proposes plans (injected `planner` fn)
 *   - MissionRouter is the sole task→executor router (all 12 gates re-run)
 *   - GovernedTaskGate is the sole dispatch authorization path
 *   - RecoveryController is the sole recovery decision authority (bounded)
 *   - ReconciliationService is the sole side-effect settlement authority
 *   - ApprovalQueue binds every human escalation to an exact scope digest
 *
 * Canonical loop (one `tick` = one persisted step):
 *   mission → plan (PLANNING) → READY → RUNNING
 *     → schedule runnable DAG tasks → route → gate → dispatch
 *     → observe → collect → artifact/result verify → task terminal
 *     → failure: classify → decide → apply action
 *       RETRY_SAME_ROUTE / RE_ROUTE → durable backoff → re-route via router
 *       REPLAN → planner → validatePlanProposal → NEW plan revision
 *       APPLY_VERIFIED_REMEDIATION → governed remediation task
 *       RECONCILIATION_REQUIRED → barrier + reconcile before any redrive
 *       HUMAN_APPROVAL_REQUIRED → approval_request → WAITING_APPROVAL
 *       ABORT → ABORTED
 *   → all tasks terminal → mission COMPLETED
 *
 * All state lives in pair.db entities (`mission_runtime`, `scheduled_action`,
 * `approval_request`, barriers on the runtime row). A process restart resumes
 * exactly: in-flight executions are re-observed, timers replayed from due_at,
 * no task is silently reset and nothing is re-dispatched twice.
 */

import fs from "node:fs";
import { IntegrityError, PairError, PolicyError } from "./errors.js";
import { digest, newId, utcnow } from "./canonical.js";
import type { PairControlPlane } from "./service.js";
import type { GovernedTaskGate } from "./gate.js";
import type { MissionRouter } from "./mission-router.js";
import type { ExecutorAdapter } from "./adapter.js";
import type { MissionScheduler } from "./mission-scheduler.js";
import {
  LEGACY_RECOVERY_BUDGET_OVERRIDE,
  type ApprovalQueue,
  type RecoveryApprovalIntent,
} from "./approval-queue.js";
import type { ReconciliationService } from "./reconciliation.js";
import type { RecoveryController } from "./recovery-controller.js";
import { classifyFailure } from "./recovery-controller.js";
import {
  assertPlanDataflow,
  assertTaskDeliverySemantic,
  deliveryManifest,
  detectTelegramDeliveryIntent,
  missingConsumedArtifact,
} from "./plan-dataflow.js";
import {
  DependencyResolutionError,
  isRemoteCapabilityTask,
} from "./artifact-handoff.js";
import {
  boundedFileSha256,
  materializeDeliveryTextPayload,
  MAX_TELEGRAM_FILE_BYTES,
  mintTelegramDeliveryRequest,
  resolveDeliveryArtifactPath,
  SHA256_HEX_RE,
} from "./telegram-delivery.js";
import {
  DELIVERY_TEXT_ARTIFACT,
  detectOutputLanguage,
  isTextDeliverableName,
  verifyOutputLanguageContent,
} from "./output-language.js";
import type { RecoveryAction } from "./recovery-controller.js";
import { projectRoutableExecutors } from "./routing-projection.js";
import { validatePlanProposal } from "./proposal.js";
import {
  assertReplanCommitReceipt,
  buildRecoveryFailureContext,
  persistedPlanSemanticDigest,
  canonicalPlanSemanticDigest,
  MAX_REPLAN_CANDIDATES_PER_DECISION,
  ReplanAttemptLedger,
  revisionBoundToAttempt,
  type DependencyReason,
  type RecoveryFailureContext,
  type ReplanAttemptRecord,
} from "./plan-feasibility.js";

export const MISSION_RUNTIME_STATES = [
  "CREATED",
  "PLANNING",
  "READY",
  "RUNNING",
  "WAITING",
  "WAITING_BACKOFF",
  "WAITING_APPROVAL",
  "RECONCILING",
  "REPLANNING",
  "RECOVERING",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "ABORTED",
] as const;
export type MissionRuntimeState = (typeof MISSION_RUNTIME_STATES)[number];

const TERMINAL_RUNTIME = new Set<MissionRuntimeState>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "ABORTED",
]);
export const TERMINAL_EXECUTION = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);
const SETTLED_TASK = new Set(["COMPLETED", "FAILED", "CANCELLED", "SKIPPED", "SUPERSEDED"]);

export const RUNTIME_TRANSITIONS: Record<MissionRuntimeState, MissionRuntimeState[]> = {
  CREATED: ["PLANNING", "READY", "CANCELLED", "ABORTED"],
  PLANNING: ["READY", "FAILED", "WAITING_APPROVAL", "CANCELLED", "ABORTED"],
  READY: ["RUNNING", "PAUSED", "CANCELLED", "ABORTED"],
  RUNNING: [
    "WAITING",
    "WAITING_BACKOFF",
    "WAITING_APPROVAL",
    "RECONCILING",
    "REPLANNING",
    "RECOVERING",
    "PAUSED",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "ABORTED",
  ],
  WAITING: ["RUNNING", "PAUSED", "CANCELLED", "ABORTED", "FAILED"],
  WAITING_BACKOFF: ["RUNNING", "RECOVERING", "CANCELLED", "ABORTED", "WAITING_APPROVAL"],
  WAITING_APPROVAL: ["RUNNING", "RECOVERING", "REPLANNING", "RECONCILING", "CANCELLED", "ABORTED", "FAILED"],
  RECONCILING: ["RUNNING", "RECOVERING", "WAITING_APPROVAL", "FAILED", "CANCELLED", "ABORTED"],
  REPLANNING: ["READY", "RUNNING", "FAILED", "CANCELLED", "ABORTED", "WAITING_APPROVAL"],
  RECOVERING: [
    "RUNNING",
    "WAITING_BACKOFF",
    "WAITING_APPROVAL",
    "RECONCILING",
    "REPLANNING",
    "FAILED",
    "CANCELLED",
    "ABORTED",
  ],
  PAUSED: ["READY", "RUNNING", "CANCELLED", "ABORTED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  ABORTED: [],
};

export interface RuntimePlannerInput {
  mission: Record<string, unknown>;
  advice?: Record<string, unknown> | null;
  /** Tasks of the superseded revision, for replans (informational). */
  superseded_tasks?: Array<Record<string, unknown>>;
  reason: string;
  /** F3 — structured failure context + rejected-candidate digests the
   *  planner MUST honor on replans: propose a feasible ALTERNATIVE, never
   *  a semantic re-emission of the failed plan. */
  replan_context?: {
    recovery_id: string;
    failure_signature: string | null;
    failure_class: string;
    dependency_reason?: string | null;
    failed_task_key?: string | null;
    failed_plan_semantic_digest: string | null;
    rejected_semantic_digests: string[];
  };
}
export type RuntimePlanner = (
  input: RuntimePlannerInput,
) => { tasks: Array<Record<string, unknown>> };

export interface MissionRuntimeDeps {
  service: PairControlPlane;
  gate: GovernedTaskGate;
  router: MissionRouter;
  adapters: Map<string, ExecutorAdapter>;
  scheduler: MissionScheduler;
  approvals: ApprovalQueue;
  reconciliation: ReconciliationService;
  recovery: RecoveryController;
  /** Automaton planning authority — injected; runtime never plans itself. */
  planner?: RuntimePlanner;
  /** P7 advisor — advisory retrieval only, never authoritative. */
  plannerAdvisor?: { advise(opts: Record<string, unknown>): Record<string, unknown> };
  environment?: Record<string, unknown>;
  actor?: string;
  /**
   * Governed task execution budget (seconds) applied when a task carries no
   * explicit metadata.timeout. Phase A: validated at startup via
   * taskTimeoutSeconds() — this field must already be a positive int.
   */
  taskTimeoutSeconds?: number;
  /** R3 §3 — exactly-one configured default Telegram destination for
   *  non-Telegram-origin missions. Unset → such delivery requests mint
   *  UNSENDABLE (fail closed, never broadcast). */
  telegramDeliveryDefaultChatId?: string;
  /** R4 §3 — canonical retry ceiling stamped per payload at mint
   *  (PAIR_TG_DELIVERY_MAX_ATTEMPTS wiring; bounded, env-driven). */
  telegramDeliveryMaxAttempts?: number;
}

const DEFAULT_TASK_TIMEOUT = 120;

export class MissionRuntime {
  private readonly actor: string;
  /** R2 — this runtime instance's process identity; used as the durable
   *  owner id on APRE claims so exactly one writer applies an approval
   *  effect and a crashed owner's lease can be taken over. */
  private readonly instanceId = newId("MRI");

  constructor(private readonly deps: MissionRuntimeDeps) {
    this.actor = deps.actor ?? "PAIR_MISSION_RUNTIME";
  }

  private get store() {
    return this.deps.service.store;
  }

  /* ---------------- runtime state entity + transitions ------------------ */

  runtimeEntity(missionId: string): Record<string, unknown> {
    const id = `MRT_${missionId}`;
    const existing = this.store.tryGet("mission_runtime", id);
    if (existing) return existing;
    const record = {
      mission_runtime_id: id,
      mission_id: missionId,
      state: "CREATED" as MissionRuntimeState,
      entered_at: utcnow(),
      reason: "mission_runtime_created",
      barriers: {} as Record<string, Record<string, unknown>>,
      pending_recovery: null as Record<string, unknown> | null,
      pending_approval_id: null as string | null,
      pending_remediation: null as Record<string, unknown> | null,
      budget_extension: { attempts_per_task: 0, attempts_per_mission: 0 },
      version: 0,
    };
    const saved = this.store.put("mission_runtime", id, record, 0);
    this.store.event({
      entity_type: "mission_runtime",
      entity_id: id,
      event_type: "MISSION_RUNTIME_CREATED",
      new_state: "CREATED",
      actor: this.actor,
      metadata: { mission_id: missionId },
    });
    return saved;
  }

  transitionRuntime(
    missionId: string,
    to: MissionRuntimeState,
    reason: string,
  ): Record<string, unknown> {
    const rt = this.runtimeEntity(missionId);
    const from = String(rt.state) as MissionRuntimeState;
    if (from === to) return rt;
    if (!(RUNTIME_TRANSITIONS[from] ?? []).includes(to)) {
      throw new IntegrityError(
        "FAIL_CLOSED_MISSION_RUNTIME_TRANSITION",
        `${from}->${to}`,
      );
    }
    rt.state = to;
    rt.entered_at = utcnow();
    rt.reason = reason;
    const saved = this.store.put(
      "mission_runtime",
      String(rt.mission_runtime_id),
      rt,
      Number(rt.version),
    );
    this.store.event({
      entity_type: "mission_runtime",
      entity_id: String(rt.mission_runtime_id),
      event_type: "MISSION_RUNTIME_TRANSITION",
      old_state: from,
      new_state: to,
      actor: this.actor,
      metadata: { mission_id: missionId, reason },
    });
    return saved;
  }

  /* ---------------- operator controls ----------------------------------- */

  pause(missionId: string, operatorId: string): Record<string, unknown> {
    if (!operatorId) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "pause");
    const rt = this.runtimeEntity(missionId);
    const mission = this.deps.service.getMission(missionId);
    if (mission.status === "RUNNING" || mission.status === "READY") {
      this.deps.service.transitionMission(missionId, "PAUSED", `OPERATOR:${operatorId}`);
    }
    if (rt.state === "RUNNING" || rt.state === "READY") {
      this.transitionRuntime(missionId, "PAUSED", `operator_pause:${operatorId}`);
    }
    return rt;
  }

  resume(missionId: string, operatorId: string): Record<string, unknown> {
    if (!operatorId) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "resume");
    const mission = this.deps.service.getMission(missionId);
    const rt = this.runtimeEntity(missionId);
    if (mission.status === "PAUSED") {
      this.deps.service.transitionMission(missionId, "RUNNING", `OPERATOR:${operatorId}`);
    }
    if (rt.state === "PAUSED") {
      this.transitionRuntime(missionId, "RUNNING", `operator_resume:${operatorId}`);
    }
    return rt;
  }

  /** Cancel: stop scheduling, request executor cancels, settle evidence. */
  cancel(missionId: string, operatorId: string): Record<string, unknown> {
    if (!operatorId) throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "cancel");
    const mission = this.deps.service.getMission(missionId);
    if (!TERMINAL_RUNTIME.has(String(mission.status) as MissionRuntimeState)) {
      const allowed = ["READY", "RUNNING", "PAUSED", "CREATED"];
      if (allowed.includes(String(mission.status))) {
        this.deps.service.transitionMission(missionId, "CANCELLED", `OPERATOR:${operatorId}`);
      }
    }
    // Request cancel on live executions; preserve evidence; unresolved
    // side-effect state is marked explicitly, never erased.
    for (const e of this.store.list("executor_execution")) {
      if (e.mission_id !== missionId) continue;
      if (TERMINAL_EXECUTION.has(String(e.execution_state))) continue;
      const adapter = this.deps.adapters.get(String(e.executor_id));
      try {
        adapter?.cancel(String(e.execution_id));
        e.execution_state = "CANCELLED";
        e.cancelled_by = `OPERATOR:${operatorId}`;
        this.store.put(
          "executor_execution",
          String(e.execution_id),
          e,
          Number(e.version),
        );
      } catch {
        e.execution_state = "UNKNOWN";
        e.cancel_requested = true;
        this.store.put(
          "executor_execution",
          String(e.execution_id),
          e,
          Number(e.version),
        );
      }
    }
    for (const t of this.deps.service.listTasks(missionId)) {
      if (!SETTLED_TASK.has(String(t.status))) {
        this.deps.service.updateTask(String(t.task_id), {
          status: "CANCELLED",
          cancelled_at: utcnow(),
        });
      }
    }
    const rt = this.runtimeEntity(missionId);
    if (!TERMINAL_RUNTIME.has(String(rt.state) as MissionRuntimeState)) {
      const legal = RUNTIME_TRANSITIONS[String(rt.state) as MissionRuntimeState] ?? [];
      if (legal.includes("CANCELLED")) {
        this.transitionRuntime(missionId, "CANCELLED", `operator_cancel:${operatorId}`);
      } else {
        rt.state = "CANCELLED";
        rt.reason = `operator_cancel:${operatorId}`;
        this.store.put(
          "mission_runtime",
          String(rt.mission_runtime_id),
          rt,
          Number(rt.version),
        );
      }
    }
    this.deps.scheduler.supersedePending(missionId, "MISSION_CANCELLED");
    return rt;
  }

  /* ---------------- governed request builder ----------------------------- */

  private requestFor(
    mission: Record<string, unknown>,
    task: Record<string, unknown>,
  ): Record<string, unknown> {
    // Canonical artifact identity is pinned at every dispatch seam that
    // reaches requestFor (initial, retry, re-route): the bytes the
    // delivery-prep task saw at dispatch are what the settle-time gate
    // compares against — a prep task that clobbers the manifested
    // artifact fails closed. Idempotent: once pinned, the first pin
    // stands for this task's lifetime (a replan mints fresh tasks).
    this.pinDeliveryArtifactDigests(mission, task);
    const md = (mission.metadata as Record<string, unknown>) ?? {};
    const tmd = (task.metadata as Record<string, unknown>) ?? {};
    const workspace = String(
      tmd.workspace ?? (md.authorized_workspaces as string[])?.[0],
    );
    return {
      mission_id: mission.mission_id,
      task_id: task.task_id,
      plan_revision: mission.plan_revision,
      task_instruction: task.task_instruction,
      workspace,
      allowed_paths: (tmd.allowed_paths as string[]) ?? [workspace],
      permissions: (mission.granted_permissions as string[]) ?? [],
      constraints: (md.constraints as string[]) ?? [],
      timeout: Number(tmd.timeout ?? this.deps.taskTimeoutSeconds ?? DEFAULT_TASK_TIMEOUT),
      expected_output_contract:
        tmd.expected_output_contract ?? { type: "TASK_RESULT" },
      requested_tools:
        (tmd.requested_tools as string[]) ??
        (task.required_capabilities as string[]) ??
        [],
      dependency_outputs: this.dependencyOutputs(String(mission.mission_id), task),
      // F2 §5/§8 — the dependency-artifact contract is resolved at the
      // ONE governed-request seam so every dispatch arm (initial,
      // retry, re-route) pins the same canonical bytes. Resolution is
      // fail-closed: an unresolvable/ambiguous/ungoverned edge throws
      // DependencyResolutionError BEFORE any executor spend.
      dependency_artifacts: this.deps.service.artifactResolver.resolveForConsumer({
        mission,
        task,
      }),
      correlation_id: `${mission.mission_id}:${task.task_id}`,
    };
  }

  /** FILES-mode artifact identity pinning — durable runtime evidence on
   *  task.metadata.pair_delivery_artifact_digests (manifest name →
   *  resolved path + SHA-256 at first dispatch). Pin-once: later
   *  requestFor calls keep the original pin so a prep task's mutation
   *  cannot re-baseline itself. */
  private pinDeliveryArtifactDigests(
    mission: Record<string, unknown>,
    task: Record<string, unknown>,
  ): void {
    const caps = (task.required_capabilities as string[]) ?? [];
    if (!caps.includes("TELEGRAM_DELIVERY")) return;
    const manifest = deliveryManifest(task);
    if (!manifest || manifest.mode !== "FILES" || !manifest.artifacts.length) {
      return;
    }
    const md = (task.metadata as Record<string, unknown>) ?? {};
    if (md.pair_delivery_artifact_digests !== undefined) return;
    const project = this.deps.service.getProject(String(mission.project_id));
    const outboxDir = `${String(project.root_location)}/outbox`;
    const workspace = String(
      md.workspace ??
        ((mission.metadata as Record<string, unknown>)
          ?.authorized_workspaces as string[])?.[0] ??
        String(project.root_location),
    );
    // R5.3 — stat-first pin: an oversized artifact is recorded with a
    // PRECISE state (TOO_LARGE) — never a generic missing pin, never a
    // full-file read merely to pin.
    const digests: Record<
      string,
      { path: string | null; sha256: string | null; state: string }
    > = {};
    for (const name of manifest.artifacts) {
      const p = resolveDeliveryArtifactPath({ outboxDir, workspace, name });
      let sha: string | null = null;
      let state = "ABSENT";
      if (p) {
        const br = boundedFileSha256(p, MAX_TELEGRAM_FILE_BYTES);
        if (br.kind === "ok") {
          sha = br.sha256;
          state = "PINNED";
        } else if (br.kind === "too_large") {
          state = "TOO_LARGE";
        }
      }
      digests[name] = { path: p, sha256: sha, state };
    }
    this.deps.service.updateTask(String(task.task_id), {
      metadata: { ...md, pair_delivery_artifact_digests: digests },
    });
  }

  /**
   * The output/delivery contract gate — runs BETWEEN result validation
   * and the TELEGRAM_DELIVERY success mark, strictly before any
   * telegram_delivery_request (external send authority) is minted.
   *
   *   FILES: every manifested artifact must resolve and be byte-identical
   *   to the identity pinned at dispatch (`pair_delivery_artifact_digests`)
   *   — a missing, fabricated, or mutated artifact fails closed. Textual
   *   manifested deliverables additionally satisfy the canonical output
   *   language (re-derived from the mission goal — never from task
   *   metadata the executor could have written).
   *   TEXT: the canonical payload artifact (outbox/report.txt) must
   *   exist and satisfy the canonical language — the executor's "DONE"
   *   is never the deliverable.
   *
   * Violation → { ok:false, violation } → task FAILED + governed
   * recovery (ARTIFACT_VALIDATION_FAILURE), zero transport.
   */
  private assertDeliveryDeliverable(
    mission: Record<string, unknown>,
    task: Record<string, unknown>,
  ):
    | {
        ok: true;
        digests: Record<string, string>;
        /** R1.1 — the ONE materialized+validated wire TEXT payload;
         *  mint stores it verbatim (VALIDATED === SENT). */
        textPayload?: string;
      }
    | { ok: false; violation: Record<string, unknown> } {
    const manifest = deliveryManifest(task);
    if (!manifest) return { ok: true, digests: {} };
    const md = (task.metadata as Record<string, unknown>) ?? {};
    const project = this.deps.service.getProject(String(mission.project_id));
    const outboxDir = `${String(project.root_location)}/outbox`;
    const workspace = String(
      md.workspace ??
        ((mission.metadata as Record<string, unknown>)
          ?.authorized_workspaces as string[])?.[0] ??
        String(project.root_location),
    );
    // Language authority is re-derived from the effective operator goal —
    // a stamped metadata value can be tampered with, the goal cannot.
    const expectedLanguage =
      detectOutputLanguage(mission.goal).code ?? null;
    const readBounded = (p: string): string => {
      const fd = fs.openSync(p, "r");
      try {
        const buf = Buffer.alloc(256 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, n).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    };
    const languageViolation = (
      artifact: string,
      text: string,
    ): Record<string, unknown> | null => {
      const v = verifyOutputLanguageContent(text, expectedLanguage);
      if (v.ok) return null;
      return {
        code: "FAIL_CLOSED_OUTPUT_LANGUAGE_MISMATCH",
        artifact,
        expected_language: v.expected,
        detected_language: v.detected,
      };
    };
    if (manifest.mode === "TEXT") {
      const p = resolveDeliveryArtifactPath({
        outboxDir,
        workspace,
        name: DELIVERY_TEXT_ARTIFACT,
      });
      if (!p) {
        return {
          ok: false,
          violation: {
            code: "FAIL_CLOSED_DELIVERY_TEXT_PAYLOAD_MISSING",
            artifact: DELIVERY_TEXT_ARTIFACT,
          },
        };
      }
      let raw = "";
      try {
        raw = readBounded(p);
      } catch {
        return {
          ok: false,
          violation: {
            code: "FAIL_CLOSED_DELIVERY_TEXT_PAYLOAD_MISSING",
            artifact: DELIVERY_TEXT_ARTIFACT,
          },
        };
      }
      // R1.1 — ONE materialization: the exact wire payload is derived
      // once with the canonical rules (trim + MAX_TEXT_BYTES) and the
      // language gate validates THAT string — never the untruncated
      // file — then mint stores it verbatim. A 3500-char English
      // prefix followed by enough Vietnamese to flip the file-level
      // classifier cannot pass-and-send English.
      const textPayload = materializeDeliveryTextPayload(raw);
      if (!textPayload.length) {
        return {
          ok: false,
          violation: {
            code: "FAIL_CLOSED_DELIVERY_TEXT_PAYLOAD_MISSING",
            artifact: DELIVERY_TEXT_ARTIFACT,
            reason: "empty_payload",
          },
        };
      }
      const bad = languageViolation(DELIVERY_TEXT_ARTIFACT, textPayload);
      if (bad) return { ok: false, violation: bad };
      return { ok: true, digests: {}, textPayload };
    }
    // FILES — R1.2 mandatory digest authority: dispatch pin exists AND
    // pin.sha256 is a valid digest AND pre-mint hash == pin. A
    // pre-contract execution reaching settle with NO pin fails closed
    // (governed recovery/replan) — it must NEVER silently re-baseline
    // against current bytes.
    const pinned = md.pair_delivery_artifact_digests as
      | Record<string, { sha256?: string | null; state?: string }>
      | undefined;
    const pinMissing = (
      name: string,
      state?: string,
    ): Record<string, unknown> =>
      state === "TOO_LARGE"
        ? {
            code: "FAIL_CLOSED_TELEGRAM_ARTIFACT_TOO_LARGE",
            artifact: name,
          }
        : {
            code: "FAIL_CLOSED_DELIVERY_ARTIFACT_PIN_MISSING",
            artifact: name,
          };
    if (pinned === undefined) {
      return {
        ok: false,
        violation: pinMissing(String(manifest.artifacts[0] ?? "?")),
      };
    }
    const digests: Record<string, string> = {};
    for (const name of manifest.artifacts) {
      const before = pinned[name];
      if (
        !before ||
        typeof before.sha256 !== "string" ||
        !SHA256_HEX_RE.test(before.sha256)
      ) {
        return {
          ok: false,
          violation: pinMissing(name, before?.state),
        };
      }
      const p = resolveDeliveryArtifactPath({ outboxDir, workspace, name });
      if (!p) {
        return {
          ok: false,
          violation: {
            code: "FAIL_CLOSED_TELEGRAM_ARTIFACT_UNRESOLVED",
            artifact: name,
          },
        };
      }
      // R5.4 — stat-first settle: an artifact grown beyond the bound
      // converges to TOO_LARGE without any full-file read.
      const br = boundedFileSha256(p, MAX_TELEGRAM_FILE_BYTES);
      if (br.kind !== "ok") {
        return {
          ok: false,
          violation: {
            code:
              br.kind === "too_large"
                ? "FAIL_CLOSED_TELEGRAM_ARTIFACT_TOO_LARGE"
                : "FAIL_CLOSED_TELEGRAM_ARTIFACT_UNRESOLVED",
            artifact: name,
          },
        };
      }
      const sha = br.sha256;
      if (before.sha256 !== sha) {
        return {
          ok: false,
          violation: {
            code: "FAIL_CLOSED_DELIVERY_ARTIFACT_MUTATED",
            artifact: name,
            expected_sha256: before.sha256,
            actual_sha256: sha,
          },
        };
      }
      digests[name] = sha;
      if (expectedLanguage && isTextDeliverableName(name)) {
        let content = "";
        try {
          content = readBounded(p);
        } catch {
          content = "";
        }
        const bad = languageViolation(name, content);
        if (bad) return { ok: false, violation: bad };
      }
    }
    return { ok: true, digests };
  }

  /** Governed dependency handoff: completed dep executions' canonical results. */
  private dependencyOutputs(
    missionId: string,
    task: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    const deps = (task.depends_on as string[]) ?? [];
    if (!deps.length) return [];
    const tasks = this.deps.service.listTasks(missionId);
    const byKeyOrId = new Map<string, Record<string, unknown>>();
    for (const t of tasks) {
      byKeyOrId.set(String(t.task_id), t);
      if (t.task_key) byKeyOrId.set(String(t.task_key), t);
    }
    const out: Array<Record<string, unknown>> = [];
    for (const dep of deps) {
      const depTask = byKeyOrId.get(String(dep));
      if (!depTask) continue;
      const exec = this.store
        .list("executor_execution")
        .find(
          (e) =>
            e.mission_id === missionId &&
            e.task_id === depTask.task_id &&
            e.execution_state === "COMPLETED",
        );
      if (exec?.result) {
        out.push({
          from_task_id: String(depTask.task_id),
          from_task_key: depTask.task_key ?? null,
          execution_id: String(exec.execution_id),
          result: exec.result,
        });
      }
    }
    return out;
  }

  /* ---------------- the tick -------------------------------------------- */

  /** One persisted step. Returns the runtime entity after the step. */
  tick(missionId: string, now?: string): Record<string, unknown> {
    let rt = this.runtimeEntity(missionId);
    let state = String(rt.state) as MissionRuntimeState;
    // R2 — the APRE lifecycle itself discovers unfinished work: any
    // APPLYING exercise converges here regardless of which state the
    // mission is in — including terminal (a crash can leave APPLYING
    // behind after the mission already settled; effect writes are
    // idempotent and state transitions are suppressed there).
    this.convergeApplyingExercises(missionId, now);
    rt = this.runtimeEntity(missionId);
    state = String(rt.state) as MissionRuntimeState;
    if (TERMINAL_RUNTIME.has(state) || state === "PAUSED") return rt;

    switch (state) {
      case "CREATED": {
        const mission = this.deps.service.getMission(missionId);
        const hasPlan = mission.plan_id != null;
        this.transitionRuntime(missionId, hasPlan ? "READY" : "PLANNING", "runtime_start");
        break;
      }
      case "PLANNING": {
        this.runPlanning(missionId);
        break;
      }
      case "READY": {
        const status = String(this.deps.service.getMission(missionId).status);
        if (status === "CREATED") {
          this.deps.service.transitionMission(missionId, "READY", this.actor);
        }
        if (status === "CREATED" || status === "READY") {
          this.deps.service.transitionMission(missionId, "RUNNING", this.actor);
        }
        this.transitionRuntime(missionId, "RUNNING", "mission_executable");
        break;
      }
      case "RUNNING":
      case "WAITING": {
        this.runRunning(missionId, now);
        break;
      }
      case "WAITING_BACKOFF": {
        this.recoveryGuard(missionId, () => {
          const due = this.deps.scheduler.dueActions(now).filter(
            (a) => a.mission_id === missionId,
          );
          if (due.length === 0) {
            const pending = this.store
              .list("scheduled_action")
              .filter(
                (a) => a.mission_id === missionId && a.status === "SCHEDULED",
              );
            if (pending.length === 0) {
              this.transitionRuntime(missionId, "RUNNING", "no_pending_backoff");
            }
            return;
          }
          this.transitionRuntime(missionId, "RECOVERING", "backoff_due");
          for (const a of due) {
            this.deps.scheduler.markScheduledAction(
              String(a.scheduled_action_id),
              "RUNNING",
            );
          }
        }, now);
        break;
      }
      case "RECOVERING": {
        this.applyPendingRecovery(missionId, now);
        break;
      }
      case "RECONCILING": {
        this.recoveryGuard(missionId, () => this.runReconciliation(missionId), now);
        break;
      }
      case "REPLANNING": {
        this.recoveryGuard(missionId, () => this.runReplan(missionId), now);
        break;
      }
      case "WAITING_APPROVAL": {
        this.recoveryGuard(missionId, () => this.checkPendingApproval(missionId, now), now);
        break;
      }
      default:
        break;
    }
    return this.runtimeEntity(missionId);
  }

  /** Drive the mission until it settles or stalls. Returns final runtime. */
  run(missionId: string, opts: { maxTicks?: number; now?: () => string } = {}) {
    const maxTicks = opts.maxTicks ?? 200;
    let last = this.runtimeEntity(missionId);
    for (let i = 0; i < maxTicks; i++) {
      const before = JSON.stringify([last.state, this.progressSnapshot(missionId)]);
      last = this.tick(missionId, opts.now?.());
      const snap = JSON.stringify([last.state, this.progressSnapshot(missionId)]);
      if (snap === before && TERMINAL_RUNTIME.has(String(last.state) as MissionRuntimeState)) break;
      if (TERMINAL_RUNTIME.has(String(last.state) as MissionRuntimeState)) break;
      if (snap === before && ["WAITING", "WAITING_BACKOFF", "WAITING_APPROVAL", "PAUSED"].includes(String(last.state))) break;
    }
    return last;
  }

  private progressSnapshot(missionId: string) {
    return {
      tasks: this.deps.service
        .listTasks(missionId)
        .map((t) => `${t.task_id}:${t.status}`),
      executions: this.store
        .list("executor_execution")
        .filter((e) => e.mission_id === missionId)
        .map((e) => `${e.execution_id}:${e.execution_state}`),
      scheduled: this.store
        .list("scheduled_action")
        .filter((a) => a.mission_id === missionId)
        .map((a) => `${a.scheduled_action_id}:${a.status}`),
    };
  }

  /* ---------------- PLANNING -------------------------------------------- */

  private runPlanning(missionId: string): void {
    const mission = this.deps.service.getMission(missionId);
    const advice = this.adviseSafely(mission);
    if (!this.deps.planner) {
      throw new PolicyError("FAIL_CLOSED_NO_PLANNER", missionId);
    }
    const proposal = this.deps.planner({ mission, advice, reason: "initial" });
    const knownCaps = new Set(
      this.store.list("capability").map((c) => String(c.capability_id)),
    );
    const tasks = validatePlanProposal(proposal, knownCaps);
    // Incident R1 — pinned plans must be data-flow sound at the commit
    // boundary: every consumed artifact requires its producer edge. A
    // planner path that bypassed the canonicalize seam still fails closed.
    // R8 — the intent↔presence invariant and instruction hygiene are
    // re-proven here with the operator request (mission.goal) as the
    // only delivery authority.
    assertPlanDataflow(tasks as unknown as Array<Record<string, unknown>>, {
      telegramIntent: detectTelegramDeliveryIntent(mission.goal),
      outputLanguage: detectOutputLanguage(mission.goal),
    });
    this.deps.service.commitPlan({
      mission_id: missionId,
      tasks: tasks as unknown as Array<Record<string, unknown>>,
      source: "AUTOMATON_PLANNER",
      reason: "initial_plan",
      proposal,
    });
    this.transitionRuntime(missionId, "READY", "plan_committed");
  }

  /* ---------------- RUNNING ---------------------------------------------- */

  private runRunning(missionId: string, now?: string): void {
    const rt = this.runtimeEntity(missionId);

    // 1. Process due scheduled recovery actions first (durable timers).
    let hasDue = false;
    this.recoveryGuard(missionId, () => {
      const due = this.deps.scheduler
        .dueActions(now)
        .filter((a) => a.mission_id === missionId);
      if (due.length > 0) {
        hasDue = true;
        for (const a of due) {
          this.deps.scheduler.markScheduledAction(String(a.scheduled_action_id), "RUNNING");
        }
        this.transitionRuntime(missionId, "RECOVERING", "due_recovery_actions");
      }
    }, now);
    if (hasDue) return;

    // R4 §11 — compatibility repair: a runtime left RUNNING with a
    // pending_recovery (the pre-fix "unhandled" fallthrough) resumes the
    // governed recovery path on ordinary ticks — no store surgery needed.
    // An action already proven unhandled is not re-driven (no transition
    // spam); RECONCILIATION_REQUIRED is always re-driven — it is handled
    // now and progresses to a bounded outcome.
    const pendingRecovery = rt.pending_recovery as Record<string, unknown> | null;
    if (pendingRecovery) {
      const pendingAction = String(pendingRecovery.action);
      if (
        pendingAction === "RECONCILIATION_REQUIRED" ||
        String(rt.reason ?? "") !== `unhandled:${pendingAction}`
      ) {
        this.applyPendingRecovery(missionId, now);
        return;
      }
    }

    // 2. Observe in-flight executions → collect terminals.
    // Executions already under a reconciliation barrier or carried by the
    // active pending_recovery are NOT re-observed here — their governed
    // path owns them (re-observing would re-decide every tick).
    const barrieredExecs = new Set<string>();
    for (const b of Object.values(
      (rt.barriers as Record<string, Record<string, unknown>>) ?? {},
    )) {
      if (b.settled !== true && b.execution_id) barrieredExecs.add(String(b.execution_id));
    }
    const inFlight = this.store
      .list("executor_execution")
      .filter(
        (e) =>
          e.mission_id === missionId &&
          !TERMINAL_EXECUTION.has(String(e.execution_state)) &&
          !e.terminal_outcome && // Phase D §5 — operator-neutralized
          !barrieredExecs.has(String(e.execution_id)),
      );
    for (const e of inFlight) {
      const adapter = this.deps.adapters.get(String(e.executor_id));
      if (!adapter) continue;
      const observed = this.deps.gate.observe_execution(adapter, String(e.execution_id));
      const observedState = String(observed.execution_state);
      if (observedState === "UNKNOWN" || String(e.execution_state) === "UNKNOWN") {
        // Phase D §5 — UNKNOWN is not terminal but can never be
        // auto-settled: drive it through governed recovery (reconcile →
        // operator no-replay acknowledgment) instead of leaving the task
        // in-flight forever.
        this.startRecovery(
          missionId,
          String(e.task_id),
          String(e.execution_id),
          "UNKNOWN_SIDE_EFFECT_STATE",
          now,
        );
        return;
      }
      if (!TERMINAL_EXECUTION.has(observedState)) continue;
      this.settleExecution(missionId, String(observed.execution_id));
      const rtNow = String(this.runtimeEntity(missionId).state);
      if (rtNow !== "RUNNING") return; // recovery/approval/reconcile took over
    }

    // 3. Dispatch runnable DAG tasks.
    const mission = this.deps.service.getMission(missionId);
    const barriers = (rt.barriers as Record<string, Record<string, unknown>>) ?? {};
    const runnable = this.deps.scheduler.pickRunnable(missionId, {
      isBlocked: (t) => {
        const barrier = barriers[String(t.task_id)];
        // R4 §9 — only an ACTIVE/unsettled barrier retains scheduling
        // authority; a settled one is historical evidence, not a block.
        if (barrier != null && barrier.settled !== true) {
          return `RECONCILIATION_BARRIER:${String(barrier.kind)}`;
        }
        return this.deps.approvals.hasPendingBlock(missionId, String(t.task_id))
          ? "PENDING_APPROVAL"
          : this.futureScheduledBlock(missionId, String(t.task_id), now);
      },
    });
    for (const task of runnable) {
      // Incident R2 §9 — pre-dispatch prerequisite evidence: when the
      // canonical pinned plan says this task consumes a workspace
      // artifact that is absent NOW, spending an executor attempt is
      // provably futile — classify DEPENDENCY_FAILURE deterministically
      // (bounded REPLAN/ABORT, zero dispatch, zero retry burn, zero
      // approval). Absence checked BEFORE dispatch only — a file
      // disappearing DURING execution proves nothing about its prior
      // presence and never reclassifies the real failure.
      let request: Record<string, unknown>;
      try {
        // F2 §12/§18 — dependency resolution runs INSIDE the governed
        // request seam; an unresolvable edge is a provable pre-dispatch
        // failure: zero routing, zero dispatch, zero spend.
        request = this.requestFor(mission, task);
      } catch (err) {
        if (err instanceof DependencyResolutionError) {
          this.startRecovery(
            missionId,
            String(task.task_id),
            null,
            "DEPENDENCY_FAILURE",
            now,
            undefined,
            undefined,
            {
              dependency_resolution_error: `${err.code}:${err.message}`,
              dependency_reason: err.dependency_reason,
              artifact_name: err.artifact_name,
              producer_task_id: err.producer_task_id,
              consumer_task_id: err.consumer_task_id,
              source_code: err.code,
            },
          );
          return;
        }
        throw err;
      }
      const missing = this.prerequisiteMissing(
        mission,
        task,
        new Set(
          ((request.dependency_artifacts as Array<Record<string, unknown>>) ?? []).map(
            (e) => String(e.logical_name),
          ),
        ),
      );
      if (missing) {
        this.startRecovery(
          missionId,
          String(task.task_id),
          null,
          "DEPENDENCY_FAILURE",
          now,
          undefined,
          undefined,
          {
            missing_artifact: missing,
            dependency_reason: "LOCAL_PREREQUISITE_MISSING",
            artifact_name: missing,
            source_code: "FAIL_CLOSED_LOCAL_PREREQUISITE_MISSING",
          },
        );
        return;
      }
      try {
        // R8 §4 — pre-dispatch semantic defense: affirmative Telegram
        // delivery semantics in task_instruction ⇒ the TASK itself must
        // require TELEGRAM_DELIVERY (its ROLE, not the executor's caps).
        // A persisted/bypassed/malformed plan reaching dispatch with a
        // send directive on a non-delivery task fails closed with zero
        // executor dispatch.
        assertTaskDeliverySemantic(task as Record<string, unknown>);
        const routed = this.deps.router.routeGovernedTask(request, this.deps.adapters);
        this.deps.service.updateTask(String(task.task_id), { status: "RUNNING" });
        const execution = routed.execution as Record<string, unknown>;
        if (execution && TERMINAL_EXECUTION.has(String(execution.execution_state))) {
          this.settleExecution(missionId, String(execution.execution_id));
        }
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (msg.includes("CAPACITY_EXHAUSTED")) {
          continue; // executor saturated — task stays READY for the next tick
        }
        const failureClass = classifyFailure({
          // The typed PairError.code classifies first — the JSON detail may
          // embed arbitrary reason codes (e.g. HEALTH_*, QUOTA_*) that must
          // not shadow the contract code that produced them.
          error_code: err instanceof PairError ? `${err.code}` : msg,
          error_class: "DISPATCH",
        });
        // Dispatch-time routing failures carry no execution row — the executor
        // the route selection failed on still becomes bounded re-route
        // evidence so RE_ROUTE excludes it instead of re-selecting it.
        this.startRecovery(
          missionId,
          String(task.task_id),
          null,
          failureClass,
          now,
          undefined,
          undefined,
          {
            failedExecutorId: String((err as PairError).meta?.executor_id ?? "") || null,
          },
        );
        return;
      }
      const rtNow = String(this.runtimeEntity(missionId).state);
      if (rtNow !== "RUNNING") return;
    }

    // 4. Terminal check.
    this.maybeComplete(missionId);
  }

  private futureScheduledBlock(
    missionId: string,
    taskId: string,
    now?: string,
  ): string | null {
    const t = now ?? utcnow();
    const pending = this.store.list("scheduled_action").find(
      (a) =>
        a.mission_id === missionId &&
        a.task_id === taskId &&
        (a.status === "SCHEDULED" || a.status === "READY") &&
        String(a.due_at) > t,
    );
    return pending ? `SCHEDULED_UNTIL:${String(pending.due_at)}` : null;
  }

  /* ---------------- settle + recovery entry ------------------------------- */

  private settleExecution(missionId: string, executionId: string): void {
    const execution = this.store.get("executor_execution", executionId);
    const adapter = this.deps.adapters.get(String(execution.executor_id));
    if (!adapter) {
      throw new PolicyError("FAIL_CLOSED_ADAPTER_NOT_BOUND", String(execution.executor_id));
    }
    const taskId = String(execution.task_id);
    if (!execution.result) {
      this.deps.gate.collect_execution_result(adapter, executionId);
    }
    const collected = this.store.get("executor_execution", executionId);
    const state = String(collected.execution_state);
    if (state === "COMPLETED") {
      const validation = this.deps.gate.validate_execution_result(executionId);
      if (String(validation.status) === "PASS") {
        const settledTask = this.store.get("task", taskId);
        const caps = (settledTask.required_capabilities as string[]) ?? [];
        let artifactSha256: Record<string, string> | undefined;
        let textPayload: string | undefined;
        if (caps.includes("TELEGRAM_DELIVERY")) {
          // Output/delivery contract gate — strictly BEFORE the success
          // mark, i.e. before any telegram_delivery_request (external
          // send authority) may be minted. FILES: every manifested
          // artifact must resolve to exactly the bytes pinned at
          // dispatch; TEXT: the canonical payload artifact must exist.
          // The canonical output language (re-derived from the mission
          // goal — never the stamp) must be satisfied by the
          // operator-facing text. Any violation: task FAILED + durable
          // evidence + governed recovery, zero send authority.
          const check = this.assertDeliveryDeliverable(
            this.deps.service.getMission(missionId),
            settledTask,
          );
          if (!check.ok) {
            this.store.appendEvidence(
              missionId,
              "DELIVERY_CONTRACT_VIOLATED",
              check.violation,
            );
            this.deps.service.updateTask(taskId, { status: "FAILED" });
            this.startRecovery(
              missionId,
              taskId,
              executionId,
              "ARTIFACT_VALIDATION_FAILURE",
              undefined,
              undefined,
              undefined,
              {
                artifact_name:
                  typeof check.violation.artifact === "string"
                    ? check.violation.artifact
                    : null,
                source_code:
                  typeof check.violation.code === "string"
                    ? check.violation.code
                    : null,
              },
            );
            return;
          }
          artifactSha256 = check.digests;
          textPayload = check.textPayload;
        }
        this.deps.service.updateTask(taskId, {
          status: "COMPLETED",
          completed_at: utcnow(),
        });
        this.store.event({
          entity_type: "task",
          entity_id: taskId,
          event_type: "TASK_COMPLETED",
          new_state: "COMPLETED",
          actor: this.actor,
          correlation_id: String(collected.correlation_id ?? ""),
        });
        // Incident R2 §6 — mint the durable canonical send request ONLY
        // for a task carrying the governed TELEGRAM_DELIVERY capability
        // AND the PAIR-stamped manifest. Everything else — file presence,
        // outbox contents, mission completion — authorizes nothing.
        if (caps.includes("TELEGRAM_DELIVERY")) {
          const mission = this.deps.service.getMission(missionId);
          const project = this.deps.service.getProject(
            String(mission.project_id),
          );
          const ws = String(
            (settledTask.metadata as Record<string, unknown> | undefined)
              ?.workspace ??
              ((mission.metadata as Record<string, unknown>)
                ?.authorized_workspaces as string[])?.[0] ??
              String(project.root_location),
          );
          mintTelegramDeliveryRequest({
            store: this.store,
            mission,
            task: settledTask,
            execution: collected,
            outboxDir: `${String(project.root_location)}/outbox`,
            workspace: ws,
            now: utcnow(),
            defaultChatId: this.deps.telegramDeliveryDefaultChatId,
            maxAttempts: this.deps.telegramDeliveryMaxAttempts,
            artifactSha256,
            textPayload,
          });
        }
        return;
      }
      // Validation failed — artifact failure, never mark success.
      this.deps.service.updateTask(taskId, { status: "FAILED" });
      this.startRecovery(
        missionId,
        taskId,
        executionId,
        "ARTIFACT_VALIDATION_FAILURE",
      );
      return;
    }
    // Terminal non-success → recovery decision.
    this.deps.service.updateTask(taskId, { status: "FAILED" });
    const errorObj =
      (collected.result as Record<string, unknown> | undefined)?.error as
        | Record<string, unknown>
        | undefined;
    const failureClass = classifyFailure({
      execution_state: state,
      error_code: String(errorObj?.message ?? errorObj?.code ?? state),
      error_class: String(errorObj?.class ?? ""),
      result: (collected.result as Record<string, unknown>) ?? null,
    });
    this.startRecovery(missionId, taskId, executionId, failureClass);
  }

  /**
   * Incident R2 §9/§10 — pre-dispatch prerequisite evidence ONLY. The
   * canonical pinned `metadata.pair_dataflow.consumes` (never executor
   * prose) is resolved against the governed workspace; a proven-absent
   * input returns its artifact name so the caller enters deterministic
   * DEPENDENCY_FAILURE without spending a dispatch. Post-execution
   * absence is deliberately NOT consulted — a consumed input the task
   * itself moved/deleted before an unrelated failure must not reclassify
   * it.
   */
  private prerequisiteMissing(
    mission: Record<string, unknown>,
    task: Record<string, unknown>,
    canonicalResolved?: Set<string>,
  ): string | null {
    // F2 — a remote consumer's declared consumes are LOGICAL artifact
    // names, not local workspace paths: nothing local can prove their
    // presence/absence — canonical resolution already gated them.
    if (isRemoteCapabilityTask(task)) return null;
    const df = (task.metadata as Record<string, unknown> | undefined)
      ?.pair_dataflow as Record<string, unknown> | undefined;
    if (!Array.isArray(df?.consumes) || df.consumes.length === 0) return null;
    // Names resolved into canonical dependency_artifacts are material-
    // ized from CAS (not the producer's workspace path) — the source
    // path may legitimately be absent.
    const raw = (df.consumes as unknown[]).map(String);
    const consumes = canonicalResolved
      ? raw.filter((n) => !canonicalResolved.has(n))
      : raw;
    if (!consumes.length) return null;
    const md = (mission.metadata as Record<string, unknown>) ?? {};
    const workspace = String(
      (task.metadata as Record<string, unknown> | undefined)?.workspace ??
        (md.authorized_workspaces as string[])?.[0] ??
        "",
    );
    if (!workspace) return null;
    const scoped = {
      ...task,
      metadata: {
        ...(task.metadata as Record<string, unknown> | undefined),
        pair_dataflow: { ...df, consumes },
      },
    } as Record<string, unknown>;
    const missing = missingConsumedArtifact({ task: scoped, workspace });
    return missing ? missing.artifact : null;
  }

  /**
   * The recovery decision is recorded, then the runtime moves to the state
   * that will execute it — retries/reroutes go through durable backoff;
   * approval blocks the task until decided; reconciliation sets a barrier.
   */
  private startRecovery(
    missionId: string,
    taskId: string,
    executionId: string | null,
    failureClass: ReturnType<typeof classifyFailure>,
    now?: string,
    /** R4 §8 — supplied when this failure chain already settled a
     *  reconciliation for the same instance; forwarded to the decision
     *  so the settled candidate is not re-selected forever. */
    settledReconciliation?: { outcome: string; reconciliation_id?: string },
    /** Live-ops Bug C — actions proven infeasible by an apply-path routing
     *  throw in THIS failure chain; forwarded to decide() so the identical
     *  attempt is rejected instead of replayed forever. */
    infeasibleActions?: Array<{ action: RecoveryAction; reason: string }>,
    /** Route-authority closure — the executor a dispatch-time routing
     *  failure was scoped to (no execution row exists yet); carried into
     *  pending.executor_id so bounded RE_ROUTE excludes it.
     *  `missing_artifact` records the pre-dispatch prerequisite evidence
     *  (R2 §9) that produced a DEPENDENCY_FAILURE. */
    extra?: {
      failedExecutorId?: string | null;
      missing_artifact?: string | null;
      dependency_resolution_error?: string | null;
      /** F3 — typed structured root-cause fields (bounded, never prose). */
      dependency_reason?: DependencyReason | string | null;
      artifact_name?: string | null;
      producer_task_id?: string | null;
      consumer_task_id?: string | null;
      source_code?: string | null;
      /** Pre-built context carried forward (e.g. replan-candidate
       *  exhaustion re-decision — the root cause is the ORIGINAL failure,
       *  not the candidate loop). */
      failure_context?: RecoveryFailureContext | null;
    },
  ): void {
    const rt = this.runtimeEntity(missionId);
    const mission = this.deps.service.getMission(missionId);
    const taskRow = this.store.tryGet("task", taskId) as
      | Record<string, unknown>
      | null;
    // F3 §19 — every recovery start binds a bounded structured root
    // cause (recomputed from committed task rows, so pre-F3 revisions
    // carry the same authority). A pre-built context wins when the
    // caller carries the chain forward (apply-failure, replan
    // exhaustion): the root cause stays the ORIGINAL failure.
    const allTaskRows = this.deps.service.listTasks(missionId);
    const failureContext: RecoveryFailureContext =
      extra?.failure_context ??
      buildRecoveryFailureContext({
        mission,
        task_id: taskId,
        task: taskRow,
        tasks: allTaskRows,
        failure_class: failureClass,
        dependency_reason:
          (extra?.dependency_reason as DependencyReason | undefined) ??
          (extra?.missing_artifact ? "LOCAL_PREREQUISITE_MISSING" : null),
        artifact_name: extra?.artifact_name ?? extra?.missing_artifact ?? null,
        producer_task_id: extra?.producer_task_id ?? null,
        consumer_task_id: extra?.consumer_task_id ?? taskId,
        source_code: extra?.source_code ?? null,
      });
    const execution = executionId
      ? this.store.tryGet("executor_execution", executionId)
      : null;
    const ext = (rt.budget_extension as Record<string, unknown>) ?? {};
    // Phase D §1 — granted attempt extensions are task-scoped: only the
    // task the approval was minted for sees its ceiling widen; every
    // other task keeps the canonical budget. Legacy flat fields remain
    // readable for grants exercised before the scoped shape existed.
    const extTasks =
      (ext.tasks as Record<
        string,
        {
          attempts_per_task?: number;
          baseline_attempts?: number;
          baseline_identical?: number;
        }
      > | undefined) ?? {};
    const extTaskEntry = extTasks[taskId];
    // Baseline-anchored extension (Phase D §1): the grant is an absolute
    // ceiling of baseline+grant — a relative +N would be consumed by the
    // escalation decision that minted it.
    const taskCeiling =
      extTaskEntry?.baseline_attempts != null
        ? Number(extTaskEntry.baseline_attempts) +
          Number(extTaskEntry.attempts_per_task ?? 0)
        : undefined;
    const identicalCeiling =
      extTaskEntry?.baseline_identical != null
        ? Number(extTaskEntry.baseline_identical) +
          Number(extTaskEntry.attempts_per_task ?? 0)
        : undefined;
    const extAttemptsPerTask =
      (taskCeiling == null ? Number(extTaskEntry?.attempts_per_task ?? 0) : 0) +
      Number((ext.attempts_per_task as number | undefined) ?? 0);
    const eligible = projectRoutableExecutors(this.deps.service).map((r) =>
      String(r.executor_id),
    );
    const verifiedRemediation = this.store
      .list("experience")
      .filter((e) => e.type === "REMEDIATION_PAIR" && e.status === "ACTIVE")
      .map((e) => String(e.experience_id ?? e.id));
    // One canonical notion of the failed executor for the whole chain —
    // the same value feeds decide() (so alternates are computed against it)
    // and persists onto pending_recovery for the apply path.
    const failedExecutorId = execution
      ? String(execution.executor_id)
      : (extra?.failedExecutorId ?? undefined);
    const decision = this.deps.recovery.decide({
      verified_remediation_ids: verifiedRemediation,
      mission_id: missionId,
      task_id: taskId,
      execution_id: executionId ?? undefined,
      governed_task_id: execution ? String(execution.governed_task_id) : undefined,
      executor_id: failedExecutorId,
      failure_class: failureClass,
      eligible_executors: eligible,
      risk_class: String(
        ((mission.metadata as Record<string, unknown>)
          ?.risk_ceiling as string) ?? "HIGH",
      ),
      correlation_id: `${missionId}:${taskId}`,
      budget_extension: {
        attempts_per_task: extAttemptsPerTask,
        attempts_per_mission: Number(ext.attempts_per_mission ?? 0),
        task_attempt_ceiling: taskCeiling,
        consecutive_identical_ceiling: identicalCeiling,
      },
      settled_reconciliation: settledReconciliation ?? null,
      infeasible_actions: infeasibleActions ?? [],
      failure_context: failureContext,
      now,
    });
    rt.pending_recovery = {
      recovery_id: decision.recovery_id,
      action: decision.selected_action,
      task_id: taskId,
      execution_id: executionId,
      governed_task_id: execution ? execution.governed_task_id : null,
      executor_id: failedExecutorId ?? null,
      failure_class: failureClass,
      backoff_ms: decision.backoff_ms,
      infeasible_actions: infeasibleActions ?? [],
      failure_context: failureContext,
      ...(extra?.missing_artifact
        ? { missing_artifact: extra.missing_artifact }
        : {}),
    };
    this.store.put(
      "mission_runtime",
      String(rt.mission_runtime_id),
      rt,
      Number(rt.version),
    );

    const action = String(decision.selected_action);
    switch (action) {
      case "RETRY_SAME_ROUTE":
      case "RE_ROUTE": {
        const backoff = Number(decision.backoff_ms);
        if (backoff > 0) {
          const dueAt = new Date(Date.parse(now ?? utcnow()) + backoff).toISOString();
          const pendingNow = rt.pending_recovery as Record<string, unknown>;
          this.deps.scheduler.schedule({
            mission_id: missionId,
            task_id: taskId,
            recovery_id: String(decision.recovery_id),
            action,
            due_at: dueAt,
            payload: { governed_task_id: pendingNow.governed_task_id, executor_id: pendingNow.executor_id },
          });
          this.transitionRuntime(missionId, "WAITING_BACKOFF", `${action}:${backoff}ms`);
        } else {
          this.transitionRuntime(missionId, "RECOVERING", action);
        }
        break;
      }
      case "APPLY_VERIFIED_REMEDIATION":
        this.transitionRuntime(missionId, "RECOVERING", action);
        break;
      case "REPLAN":
        this.transitionRuntime(missionId, "REPLANNING", action);
        break;
      case "RECONCILIATION_REQUIRED": {
        const rt2 = this.runtimeEntity(missionId);
        rt2.barriers = {
          ...((rt2.barriers as Record<string, unknown>) ?? {}),
          [taskId]: {
            kind: "RECONCILIATION",
            execution_id: executionId,
            recovery_id: decision.recovery_id,
            since: utcnow(),
          },
        };
        this.store.put("mission_runtime", String(rt2.mission_runtime_id), rt2, Number(rt2.version));
        this.transitionRuntime(missionId, "RECONCILING", action);
        break;
      }
      case "HUMAN_APPROVAL_REQUIRED": {
        // Phase D §1 — the approval carries an explicit governed intent
        // derived from WHY the human was required (read from the decision's
        // rejection reasons), never a generic budget override.
        this.mintRecoveryApproval(
          missionId,
          taskId,
          this.approvalIntentFor(
            decision,
            failureClass,
            failedExecutorId,
            executionId,
          ),
        );
        break;
      }
      case "ABORT":
      default: {
        this.abortMission(missionId, `recovery_abort:${failureClass}`);
        break;
      }
    }
  }

  /* ---------------- RECOVERING — execute the selected action ------------- */

  private applyPendingRecovery(missionId: string, now?: string): void {
    const rt = this.runtimeEntity(missionId);
    const pending = rt.pending_recovery as Record<string, unknown> | null;
    if (!pending) {
      this.transitionRuntime(missionId, "RUNNING", "no_pending_recovery");
      return;
    }
    const action = String(pending.action);
    const taskId = String(pending.task_id);

    // Audit R: the WHOLE apply arm runs inside one boundary. Only the router
    // calls keep their own catch (they convert an expected PolicyError into
    // infeasible evidence for the attempted action). Every other statement
    // in the arm — supersede, task fetch/update, remediation internals —
    // that throws would otherwise escape to the supervisor's silent catch
    // and replay the unchanged pending_recovery every tick: the same
    // permanent-RECOVERING limbo this closure exists to remove.
    try {
      this.applyRecoveryAction(missionId, pending, action, taskId, now);
    } catch (err) {
      this.recoveryFailureBoundary(missionId, pending, action, err, now);
    }
  }

  /**
   * Runs a recovery-driven tick body under the apply-failure boundary. Any
   * throw while an actionable pending_recovery exists is converted into a
   * bounded recovery outcome instead of escaping to the supervisor's silent
   * catch — covering the non-RECOVERING legs of a recovery chain
   * (WAITING_BACKOFF, RECONCILING, REPLANNING, WAITING_APPROVAL) where the
   * same pending_recovery would otherwise replay forever.
   */
  private recoveryGuard(missionId: string, fn: () => void, now?: string): void {
    try {
      fn();
    } catch (err) {
      let pending: Record<string, unknown> | null;
      try {
        pending = this.runtimeEntity(missionId).pending_recovery as
          | Record<string, unknown>
          | null;
      } catch {
        // The pending read itself failed — there may still be an
        // actionable recovery. Terminalize via the emergency path (its own
        // read decides whether anything durable is possible) rather than
        // feeding a stub pending into the decision machinery.
        const msg = String(
          (err as { message?: string })?.message ?? err,
        ).replace(/\s+/g, " ").slice(0, 120);
        this.forceAbortRuntime(missionId, `recovery_boundary_defect:${msg}`);
        return;
      }
      if (!pending) throw err;
      this.recoveryFailureBoundary(
        missionId,
        pending,
        String(pending.action),
        err,
        now,
      );
    }
  }

  /**
   * Last boundary for recovery-apply failures. A normal throw becomes an
   * infeasible/defect re-decide via handleRecoveryApplyFailure; if THAT
   * fails too (illegal decided transition, decide() defect, mission
   * entity unavailable, ...), forceAbortRuntime terminalizes the runtime
   * directly. NOT abortMission: abortMission reads the mission entity
   * first, and a missing/corrupt mission row is exactly the failure this
   * fallback exists for — routing through it would recreate the same
   * silent-replay escape the boundary closes.
   */
  private recoveryFailureBoundary(
    missionId: string,
    pending: Record<string, unknown>,
    action: string,
    err: unknown,
    now?: string,
  ): void {
    try {
      this.handleRecoveryApplyFailure(missionId, pending, action, err, now);
    } catch (inner) {
      const msg = String(
        (inner as { message?: string })?.message ?? inner,
      ).replace(/\s+/g, " ").slice(0, 120);
      this.forceAbortRuntime(missionId, `recovery_boundary_defect:${msg}`);
    }
  }

  /**
   * Emergency runtime terminalization — the final no-escape step inside the
   * recovery failure boundary. Terminalizes ONLY the mission_runtime row;
   * it must not depend on service.getMission / transitionMission / decide /
   * scheduler / approvals / router / executor / reconciliation, any of
   * which may be the dependency that is failing.
   *
   * Precise durability guarantee: while the mission_runtime row remains
   * readable and writable, failures elsewhere cannot leave the same
   * recovery action silently replayable. If the canonical store itself
   * cannot read/write the row, durable terminalization is impossible from
   * this layer and the error escapes — an infrastructure failure outside
   * this boundary's scope, not a hidden recovery path.
   *
   * Order is fixed: persist ABORTED + neutralize pending_recovery first;
   * only afterwards attempt best-effort mission → FAILED sync, whose
   * failure must never undo or block the runtime terminal state.
   */
  private forceAbortRuntime(missionId: string, reason: string): void {
    const rt = this.runtimeEntity(missionId);
    const prior = rt.pending_recovery as Record<string, unknown> | null;
    const from = String(rt.state);
    if (prior) {
      // Keep forensic evidence but make the recovery non-actionable:
      // state ABORTED is terminal (supervisor excludes it) and
      // pending_recovery is cleared so nothing re-drives it after restart.
      rt.aborted_recovery = {
        recovery_id: prior.recovery_id ?? null,
        action: prior.action ?? null,
        task_id: prior.task_id ?? null,
        failure_class: prior.failure_class ?? null,
        aborted_reason: reason,
      };
      rt.pending_recovery = null;
    }
    if (from !== "ABORTED") {
      rt.state = "ABORTED";
      rt.entered_at = utcnow();
      rt.reason = reason;
      this.store.put(
        "mission_runtime",
        String(rt.mission_runtime_id),
        rt,
        Number(rt.version),
      );
      try {
        this.store.event({
          entity_type: "mission_runtime",
          entity_id: String(rt.mission_runtime_id),
          event_type: "MISSION_RUNTIME_EMERGENCY_ABORT",
          old_state: from,
          new_state: "ABORTED",
          actor: this.actor,
          metadata: { mission_id: missionId, reason },
        });
      } catch {
        /* event journal is best-effort; the terminal row is already durable */
      }
    }
    // Best-effort mission sync AFTER runtime is durably terminal.
    try {
      const mission = this.deps.service.getMission(missionId);
      if (["READY", "RUNNING", "PAUSED"].includes(String(mission.status))) {
        this.deps.service.transitionMission(missionId, "FAILED", this.actor);
      }
    } catch {
      /* mission entity unavailable — runtime ABORTED stands */
    }
  }

  private applyRecoveryAction(
    missionId: string,
    pending: Record<string, unknown>,
    action: string,
    taskId: string,
    now?: string,
  ): void {
    const mission = this.deps.service.getMission(missionId);

    switch (action) {
      case "RETRY_SAME_ROUTE": {
        this.supersedeGovernedTaskOnce(pending);
        const task = this.deps.service.getTask(taskId);
        this.deps.service.updateTask(taskId, { status: "READY" });
        const request = this.requestFor(mission, task);
        request.executor_constraint = pending.executor_id;
        let routed: Record<string, unknown>;
        try {
          routed = this.deps.router.routeGovernedTask(request, this.deps.adapters);
        } catch (err) {
          this.handleRecoveryApplyFailure(missionId, pending, "RETRY_SAME_ROUTE", err, now);
          return;
        }
        this.deps.service.updateTask(taskId, { status: "RUNNING" });
        const execution = routed.execution as Record<string, unknown> | undefined;
        if (execution && TERMINAL_EXECUTION.has(String(execution.execution_state))) {
          this.settleExecution(missionId, String(execution.execution_id));
        }
        // Only close the apply when THIS chain's pending is still the
        // active one. A terminal settle inside the arm may have spawned a
        // fresh recovery decision — clearing that successor's pending
        // kills the chain and leaves the mission stuck RUNNING.
        const rtAfterRetry = this.runtimeEntity(missionId);
        const pendingAfterRetry = rtAfterRetry.pending_recovery as
          | Record<string, unknown>
          | null;
        if (
          String(rtAfterRetry.state) === "RECOVERING" &&
          pendingAfterRetry &&
          String(pendingAfterRetry.recovery_id) === String(pending.recovery_id)
        ) {
          this.clearPendingRecovery(missionId, "COMPLETED", "retry_dispatched");
          this.transitionRuntime(missionId, "RUNNING", "retry_dispatched");
        }
        break;
      }
      case "RE_ROUTE": {
        this.supersedeGovernedTaskOnce(pending);
        const task = this.deps.service.getTask(taskId);
        this.deps.service.updateTask(taskId, { status: "READY" });
        const request = this.requestFor(mission, task);
        if (pending.executor_id) {
          request.exclude_executors = [pending.executor_id];
        }
        let routed: Record<string, unknown>;
        try {
          routed = this.deps.router.routeGovernedTask(request, this.deps.adapters);
        } catch (err) {
          this.handleRecoveryApplyFailure(missionId, pending, "RE_ROUTE", err, now);
          return;
        }
        this.deps.service.updateTask(taskId, { status: "RUNNING" });
        const execution = routed.execution as Record<string, unknown> | undefined;
        if (execution && TERMINAL_EXECUTION.has(String(execution.execution_state))) {
          this.settleExecution(missionId, String(execution.execution_id));
        }
        const rtAfterReroute = this.runtimeEntity(missionId);
        const pendingAfterReroute = rtAfterReroute.pending_recovery as
          | Record<string, unknown>
          | null;
        if (
          String(rtAfterReroute.state) === "RECOVERING" &&
          pendingAfterReroute &&
          String(pendingAfterReroute.recovery_id) === String(pending.recovery_id)
        ) {
          this.clearPendingRecovery(missionId, "COMPLETED", "reroute_dispatched");
          this.transitionRuntime(missionId, "RUNNING", "reroute_dispatched");
        }
        break;
      }
      case "APPLY_VERIFIED_REMEDIATION": {
        this.runRemediation(missionId, pending, now);
        break;
      }
      case "HUMAN_APPROVAL_REQUIRED": {
        // Phase D §3 — the pending escalation survived a restart before
        // the runtime link was durable: re-derive the intent and
        // mint-or-relink (the queue dedupes equivalents) instead of
        // minting a second identical request.
        const decision = this.store.tryGet(
          "recovery_decision",
          String(pending.recovery_id ?? ""),
        );
        this.mintRecoveryApproval(
          missionId,
          taskId,
          this.approvalIntentFor(
            decision ?? {},
            String(pending.failure_class) as ReturnType<typeof classifyFailure>,
            pending.executor_id ? String(pending.executor_id) : undefined,
            pending.execution_id ? String(pending.execution_id) : null,
            pending.recovery_id ? String(pending.recovery_id) : null,
          ),
        );
        break;
      }
      case "RECONCILIATION_REQUIRED": {
        // R4 §7 — the reconcile already ran and returned a verdict. When
        // it proved CONFIRMED_NOT_EXECUTED, replay is safe from the
        // side-effect perspective: the stale pending action is superseded
        // and a FRESH governed recovery decision re-evaluates the next
        // action (the settled candidate can never re-select itself).
        const rt3 = this.runtimeEntity(missionId);
        const barrier = (
          (rt3.barriers as Record<string, Record<string, unknown>>) ?? {}
        )[taskId];
        const barrierOutcome = String(barrier?.last_outcome ?? "");
        const pendingNow = rt3.pending_recovery as Record<string, unknown>;
        if (
          barrier &&
          barrier.settled === true &&
          barrierOutcome === "CONFIRMED_NOT_EXECUTED"
        ) {
          this.clearPendingRecovery(missionId, "COMPLETED", "reconcile_confirmed_not_executed");
          this.startRecovery(
            missionId,
            taskId,
            pendingNow.execution_id ? String(pendingNow.execution_id) : null,
            pendingNow.failure_class as ReturnType<typeof classifyFailure>,
            now,
            {
              outcome: barrierOutcome,
              reconciliation_id: String(barrier.last_receipt_id ?? ""),
            },
          );
        } else if (barrier && barrier.settled === true) {
          // Settled with any other verdict — the reconcile outcome was
          // already applied (settle/escalate); the stale pending action
          // is complete and must not keep re-driving.
          this.clearPendingRecovery(missionId, "COMPLETED", `reconcile_outcome:${barrierOutcome}`);
          this.transitionRuntime(missionId, "RUNNING", `reconcile_outcome:${barrierOutcome}`);
        } else if (!barrier) {
          // Pending reconciliation with no barrier evidence — a fresh
          // governed decision re-drives; it may legitimately select
          // RECONCILIATION_REQUIRED again and rebuild the barrier.
          this.clearPendingRecovery(missionId, "COMPLETED", "reconcile_barrier_absent");
          this.startRecovery(
            missionId,
            taskId,
            pendingNow.execution_id ? String(pendingNow.execution_id) : null,
            pendingNow.failure_class as ReturnType<typeof classifyFailure>,
            now,
          );
        } else {
          // Barrier still unsettled — let the RECONCILING path settle it.
          this.transitionRuntime(missionId, "RECONCILING", "reconcile_pending");
        }
        break;
      }
      default:
        this.transitionRuntime(missionId, "RUNNING", `unhandled:${action}`);
    }
  }

  /**
   * Supersede the failed governed task once per failure chain. Within one
   * chain the same governed_task_id is carried across re-decisions
   * (RE_ROUTE → RETRY_SAME_ROUTE), so the second apply sees it already
   * SUPERSEDED — that is idempotent no-op territory, not corruption, and
   * re-superseding must not throw the chain into limbo. A genuinely
   * non-supersedeable state (e.g. mid-execution) still throws through
   * supersedeGovernedTask and flows into handleRecoveryApplyFailure's
   * INTERNAL_RUNTIME_DEFECT path.
   */
  private supersedeGovernedTaskOnce(pending: Record<string, unknown>): void {
    if (!pending.governed_task_id) return;
    const gtId = String(pending.governed_task_id);
    const gt = this.store.tryGet("governed_task", gtId);
    if (gt && String(gt.governance_state).startsWith("SUPERSEDED")) return;
    this.deps.recovery.supersedeGovernedTask(gtId, String(pending.recovery_id));
  }

  /**
   * Live-ops Bug C — a governed routing call inside a recovery apply-path
   * threw before the recovery state was advanced. Feeding the failure back
   * as `infeasible_actions` marks the attempted action infeasible for this
   * failure chain, so the fresh canonical decide() evaluates the NEXT
   * matrix action (typically HUMAN_APPROVAL_REQUIRED or ABORT) instead of
   * replaying the identical throw every supervisor tick — the observed
   * permanent-RECOVERING limbo on MSN_01M3VHGS6HPA62V6K9JR57MNEK.
   *
   * Expected governed routing/policy failures (PolicyError thrown by the
   * router) become recovery evidence in the original failure class.
   * Anything else (IntegrityError, invariant corruption, programmer bugs)
   * is NOT normalized into routing infeasibility — it re-decides under
   * INTERNAL_RUNTIME_DEFECT, the existing canonical defect class, keeping
   * the outcome bounded and operator-visible via the recovery_decision row.
   */
  private handleRecoveryApplyFailure(
    missionId: string,
    pending: Record<string, unknown>,
    action: string,
    err: unknown,
    now?: string,
  ): void {
    const taskId = String(pending.task_id);
    const prior =
      (pending.infeasible_actions as Array<{ action: RecoveryAction; reason: string }>) ?? [];
    const code =
      err instanceof PolicyError
        ? String(err.code)
        : String((err as { code?: string })?.code ?? "INTERNAL_ERROR");
    const infeasible: Array<{ action: RecoveryAction; reason: string }> = [
      ...prior.filter((e) => e.action !== action),
      { action: action as RecoveryAction, reason: code },
    ];
    const isExpectedGovernedRouting = err instanceof PolicyError;
    this.startRecovery(
      missionId,
      taskId,
      pending.execution_id ? String(pending.execution_id) : null,
      isExpectedGovernedRouting
        ? (pending.failure_class as ReturnType<typeof classifyFailure>)
        : "INTERNAL_RUNTIME_DEFECT",
      now,
      undefined,
      infeasible,
      {
        // The executor THIS apply attempt just failed on wins over the chain's
        // prior executor — the next RE_ROUTE excludes it too.
        failedExecutorId:
          String((err as PairError).meta?.executor_id ?? "") ||
          (pending.executor_id ? String(pending.executor_id) : null),
        // F3 — the apply-path defect chains off the ORIGINAL failure's
        // root cause, never a fresh one.
        failure_context:
          (pending.failure_context as RecoveryFailureContext | undefined) ??
          null,
      },
    );
  }

  private runRemediation(
    missionId: string,
    pending: Record<string, unknown>,
    now?: string,
  ): void {
    const recovery = this.deps.recovery;
    const decision = this.store.get("recovery_decision", String(pending.recovery_id));
    const expId = decision.remediation_experience_id as string | null;
    if (!expId) {
      this.startRecovery(missionId, String(pending.task_id), String(pending.execution_id ?? "") || null, "INTERNAL_RUNTIME_DEFECT", now);
      return;
    }
    const mission = this.deps.service.getMission(missionId);
    const md = (mission.metadata as Record<string, unknown>) ?? {};
    if (!rt_pendingRemediation(this.runtimeEntity(missionId))) {
      try {
        recovery.verifyRemediationAdmissible(expId, {
          executor_id: String(pending.executor_id ?? ""),
          environment: this.deps.environment ?? {},
          risk_ceiling: String(md.risk_ceiling ?? "HIGH"),
        });
      } catch {
        this.startRecovery(missionId, String(pending.task_id), String(pending.execution_id ?? "") || null, "ENVIRONMENT_INCOMPATIBLE", now);
        return;
      }
      const proposal = recovery.proposeRemediationTask({
        mission_id: missionId,
        parent_task_id: String(pending.task_id),
        recovery_id: String(pending.recovery_id),
        experience_id: expId,
        task_instruction: `remediation for ${String(pending.task_id)}`,
        workspace: String((md.authorized_workspaces as string[])?.[0] ?? ""),
        permissions: (mission.granted_permissions as string[]) ?? [],
        required_capabilities: ["FILE_OPERATIONS"],
        plan_revision: Number(mission.plan_revision ?? 1),
        correlation_id: `${missionId}:remediation:${expId}`,
      });
      // The remediation request flows through MissionRouter like any task —
      // it needs a real task row in the active plan revision.
      const active = this.deps.service.activeRevision(missionId);
      const remTaskId = newId("TSK");
      const exp = this.store.get("experience", expId);
      this.store.put(
        "task",
        remTaskId,
        {
          task_id: remTaskId,
          task_key: `REM_${String(pending.recovery_id)}`,
          mission_id: missionId,
          plan_id: active.plan_id,
          order: 10_000 + this.deps.service.listTasks(missionId).length,
          title: `remediation:${expId}`,
          description: String((exp.payload as Record<string, unknown>)?.remediation ?? ""),
          task_instruction: `remediation for ${String(pending.task_id)}`,
          required_capabilities: ["FILE_OPERATIONS"],
          selected_executor: null,
          status: "DISPATCHED", // routed via recovery path, not pickRunnable
          metadata: { remediation_of: pending.task_id, recovery_id: pending.recovery_id },
          depends_on: [],
          created_at: utcnow(),
          version: 0,
        },
        0,
      );
      const rt = this.runtimeEntity(missionId);
      rt.pending_remediation = {
        remediation_execution_id: proposal.remediation_execution_id,
        remediation_task_id: remTaskId,
        request: proposal.request,
        task_id: pending.task_id,
      };
      this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
    }
    const rt2 = this.runtimeEntity(missionId);
    const pr = rt2.pending_remediation as Record<string, unknown>;
    const remExec = this.store.get(
      "remediation_execution",
      String(pr.remediation_execution_id),
    );
    if (String(remExec.state) === "PROPOSED") {
      const request: Record<string, unknown> = {
        ...(pr.request as Record<string, unknown>),
        task_id: String(pr.remediation_task_id),
      };
      if (pending.executor_id) {
        request.executor_constraint = pending.executor_id;
      }
      let routed: Record<string, unknown>;
      try {
        routed = this.deps.router.routeGovernedTask(request, this.deps.adapters);
      } catch (err) {
        this.handleRecoveryApplyFailure(missionId, pending, "APPLY_VERIFIED_REMEDIATION", err, now);
        return;
      }
      this.deps.recovery.bindRemediationExecution(
        String(pr.remediation_execution_id),
        String((routed.governed_task as Record<string, unknown>).governed_task_id),
        String((routed.execution as Record<string, unknown>).execution_id),
      );
      return; // next tick observes the remediation execution
    }
    if (String(remExec.state) === "DISPATCHED") {
      const execId = String(remExec.execution_id);
      const execution = this.store.get("executor_execution", execId);
      const adapter = this.deps.adapters.get(String(execution.executor_id));
      if (adapter) {
        const observed = this.deps.gate.observe_execution(adapter, execId);
        if (TERMINAL_EXECUTION.has(String(observed.execution_state))) {
          this.deps.gate.collect_execution_result(adapter, execId);
          const collected = this.store.get("executor_execution", execId);
          const outcome = this.deps.recovery.evaluateRemediationOutcome(
            String(pr.remediation_execution_id),
            String(collected.execution_state),
          );
          const remTaskId = String(pr.remediation_task_id);
          if (remTaskId && this.store.tryGet("task", remTaskId)) {
            this.deps.service.updateTask(remTaskId, {
              status:
                String(outcome.state) === "REMEDIATION_SUCCEEDED"
                  ? "COMPLETED"
                  : "FAILED",
              completed_at: utcnow(),
            });
          }
          if (String(outcome.state) === "REMEDIATION_SUCCEEDED") {
            // Original task gets a fresh bounded recovery decision.
            const task = this.deps.service.getTask(String(pr.task_id));
            this.deps.service.updateTask(String(task.task_id), { status: "READY" });
            this.clearPendingRecovery(missionId, "COMPLETED", "remediation_succeeded");
            this.transitionRuntime(missionId, "RECOVERING", "remediation_succeeded_retry");
          } else if (String(outcome.state) === "RECONCILIATION_REQUIRED") {
            const r = this.runtimeEntity(missionId);
            r.barriers = {
              ...((r.barriers as Record<string, unknown>) ?? {}),
              [String(pr.task_id)]: {
                kind: "RECONCILIATION",
                execution_id: execId,
                since: utcnow(),
              },
            };
            this.store.put("mission_runtime", String(r.mission_runtime_id), r, Number(r.version));
            this.transitionRuntime(missionId, "RECONCILING", "remediation_unknown");
          } else {
            this.clearPendingRecovery(missionId, "COMPLETED", "remediation_failed");
            this.startRecovery(missionId, String(pr.task_id), String(pending.execution_id ?? "") || null, "INTERNAL_RUNTIME_DEFECT", now);
          }
        }
      }
      return;
    }
  }

  /* ---------------- Phase D approval intent/exercise ------------------ */

  /**
   * Phase D §1 — derive the explicit governed intent for a decided
   * HUMAN_APPROVAL_REQUIRED chain from WHY the human was required:
   * a task-attempt ceiling rejection grants one task-scoped attempt
   * extension; every other operator-required reason is revalidation
   * (approve ⇒ one fresh bounded re-decision, no budget widening).
   */
  private approvalIntentFor(
    decision: Record<string, unknown>,
    failureClass: ReturnType<typeof classifyFailure>,
    failedExecutorId: string | undefined,
    executionId: string | null,
    recoveryId?: string | null,
  ): {
    intent: RecoveryApprovalIntent;
    reason: string;
    risk_class: string;
    failure_signature: string;
    recovery_decision_id: string | null;
    execution_id: string | null;
    grant: Record<string, unknown> | null;
  } {
    const rejects =
      (decision.rejected_actions as Array<{ reason?: string }> | undefined) ?? [];
    const ceilingHit = rejects.some((r) =>
      /MAX_RECOVERY_ATTEMPTS_PER_TASK|RETRY_BUDGET_EXHAUSTED/.test(
        String(r.reason ?? ""),
      ),
    );
    return {
      intent: ceilingHit
        ? "RECOVERY_TASK_ATTEMPT_EXTENSION"
        : "RECOVERY_OPERATOR_REVALIDATION",
      reason: `recovery escalation: ${failureClass}`,
      risk_class: String(decision.risk_class ?? "MEDIUM"),
      failure_signature: String(
        decision.failure_signature ?? `${failureClass}::${failedExecutorId ?? "any"}::any`,
      ),
      recovery_decision_id:
        (decision.recovery_id as string | undefined) ?? recoveryId ?? null,
      execution_id: executionId,
      grant: ceilingHit ? { attempts_per_task: 1 } : null,
    };
  }

  /**
   * Phase D §3/§7 — mint OR relink the recovery approval for a decided
   * chain, bounded:
   *  - an identical already-EXERCISED grant (same intent + mission + task
   *    + failure signature) means the same failure returned without
   *    meaningful state change → bounded abort, never a second
   *    equivalent approval;
   *  - an equivalent still-PENDING request (crash-before-linkage,
   *    restart re-decision) is ADOPTED, not duplicated;
   *  - otherwise a fresh request is minted carrying the explicit intent
   *    and the scope it binds (mission/task/decision/signature/grant).
   */
  private mintRecoveryApproval(
    missionId: string,
    taskId: string,
    spec: {
      intent: RecoveryApprovalIntent;
      reason: string;
      risk_class?: string;
      failure_signature?: string | null;
      recovery_decision_id?: string | null;
      execution_id?: string | null;
      grant?: Record<string, unknown> | null;
    },
  ): void {
    const signature = spec.failure_signature ?? null;
    if (signature) {
      const alreadyExercised = this.deps.approvals
        .listExercised({ mission_id: missionId, task_id: taskId })
        .some(
          (x) =>
            String(x.requested_action) === spec.intent &&
            String(
              (x.intent as Record<string, unknown> | null)?.failure_signature ??
                (x.scope_snapshot as Record<string, unknown> | null)?.failure_signature ??
                "",
            ) === signature,
        );
      if (alreadyExercised) {
        const rt0 = this.runtimeEntity(missionId);
        rt0.pending_approval_id = null;
        this.store.put(
          "mission_runtime",
          String(rt0.mission_runtime_id),
          rt0,
          Number(rt0.version),
        );
        this.abortMission(missionId, `approval_chain_bounded:${signature}`);
        return;
      }
    }
    const equivalent = this.deps.approvals.findPendingEquivalent({
      approval_type: "RECOVERY_APPROVAL",
      requested_action: spec.intent,
      mission_id: missionId,
      task_id: taskId,
      failure_signature: signature,
    });
    const rt2 = this.runtimeEntity(missionId);
    if (equivalent) {
      rt2.pending_approval_id = String(equivalent.approval_id);
      this.store.put(
        "mission_runtime",
        String(rt2.mission_runtime_id),
        rt2,
        Number(rt2.version),
      );
      this.transitionRuntime(missionId, "WAITING_APPROVAL", "HUMAN_APPROVAL_REQUIRED");
      return;
    }
    const scope = {
      requested_action: spec.intent,
      mission_id: missionId,
      task_id: taskId,
      failure_signature: signature,
      recovery_decision_id: spec.recovery_decision_id ?? null,
      execution_id: spec.execution_id ?? null,
      grant: spec.grant ?? null,
    };
    const approval = this.deps.approvals.request({
      approval_type: "RECOVERY_APPROVAL",
      requested_action: spec.intent,
      scope,
      intent: {
        kind: spec.intent,
        mission_id: missionId,
        task_id: taskId,
        failure_signature: signature,
        recovery_decision_id: spec.recovery_decision_id ?? null,
        execution_id: spec.execution_id ?? null,
        grant: spec.grant ?? null,
      },
      mission_id: missionId,
      task_id: taskId,
      reason: spec.reason,
      risk_class: spec.risk_class ?? "MEDIUM",
      correlation_id: `${missionId}:${taskId}`,
    });
    rt2.pending_approval_id = String(approval.approval_id);
    this.store.put(
      "mission_runtime",
      String(rt2.mission_runtime_id),
      rt2,
      Number(rt2.version),
    );
    this.transitionRuntime(missionId, "WAITING_APPROVAL", "HUMAN_APPROVAL_REQUIRED");
  }

  /**
   * Phase D §2/§4/§5 — APPROVED arm: durable exactly-once exercise, then
   * the ONE effect the explicit intent permits. Every effect write is
   * idempotent (assignment, never increment) so a crash between the
   * exercise row and the runtime update re-converges cleanly.
   */
  private exerciseApprovedRecovery(missionId: string, approvalId: string, now?: string): void {
    // WAITING_APPROVAL's APPROVED arm converges through the same owned
    // apply path the orphan sweep uses — one code path, one lifecycle.
    this.convergeExercise(missionId, approvalId, now);
  }

  /** R2 — discover unfinished exercises on EVERY non-terminal tick. The
   *  APRE lifecycle alone is authoritative: a crash can leave APPLYING
   *  behind while the runtime already sits in RECOVERING/RUNNING/
   *  WAITING_BACKOFF/RECONCILING — the mission's current state is not
   *  evidence about the exercise's completeness. */
  private convergeApplyingExercises(missionId: string, now?: string): void {
    for (const row of this.deps.approvals.listExercised({
      mission_id: missionId,
    })) {
      if (String(row.state ?? "APPLIED") === "APPLIED") continue;
      this.convergeExercise(missionId, String(row.approval_id), now);
    }
  }

  /** R2 — claim the exercise, apply its ONE effect idempotently, close
   *  the lifecycle. Ownership is a durable CAS lease on the APRE row:
   *  exactly one writer applies; a loser converges on the canonical row
   *  (never a version-conflict defect); an APPLYING row whose owner died
   *  is taken over once its bounded lease expires. Effect application is
   *  driven from the persisted deterministic plan so partial writes from
   *  a crashed owner re-apply identically, and every effect is keyed to
   *  `approval_exercise_id` so re-entry never stacks or re-mints. */
  private convergeExercise(
    missionId: string,
    approvalId: string,
    now?: string,
  ): void {
    // Ensure the canonical APRE row exists before claiming: the winner's
    // deterministic plan is persisted on it, so resumers never recompute
    // drift-prone baselines.
    const approval = this.deps.approvals.get(approvalId);
    const intent = String(
      (approval.intent as Record<string, unknown> | null)?.kind ??
        approval.requested_action,
    );
    const taskId = String(approval.task_id ?? "");
    const ensure = this.deps.approvals.exercise(
      approvalId,
      this.exerciseEffectPlan(missionId, approval, intent, taskId),
    );
    if (ensure.contention) return; // R6: writer lock — retry next tick
    const apre0 = ensure.row!;
    const claim = this.deps.approvals.claimExercise(
      approvalId,
      this.instanceId,
      now,
    );
    if (claim.contention) return; // R6: writer lock — converge, retry
    const row0 = claim.applied || claim.owned ? claim.row : apre0;
    const exerciseId = String(row0!.approval_exercise_id);
    const row = row0!;
    const rt = this.runtimeEntity(missionId);
    if (claim.applied) {
      // Effect already durable — converge bookkeeping only.
      if (String(rt.pending_approval_id ?? "") === approvalId) {
        rt.pending_approval_id = null;
        this.store.put(
          "mission_runtime",
          String(rt.mission_runtime_id),
          rt,
          Number(rt.version),
        );
      }
      if (String(rt.state) === "WAITING_APPROVAL") {
        this.transitionRuntime(missionId, "RUNNING", "approval_already_exercised");
      }
      return;
    }
    if (!claim.owned) {
      // Another live writer owns the apply — converge normally; this
      // instance's next tick re-checks once the owner lands or the lease
      // expires. Losing a CAS race is never a runtime defect.
      return;
    }
    const effect = (row.effect as Record<string, unknown> | null) ?? {};
    rt.pending_approval_id = null;
    // State transitions belong to the WAITING_APPROVAL arm only: in the
    // orphan-converge path the effect's transition already landed (or
    // the mission moved on), so re-transitioning would stomp live state.
    const rtState = String(rt.state);
    const waiting = rtState === "WAITING_APPROVAL";
    const terminal = TERMINAL_RUNTIME.has(rtState as MissionRuntimeState);
    // R5 — atomic fencing: `claim_epoch` is the authority, and every
    // bounded effect stage re-verifies it INSIDE the same BEGIN
    // IMMEDIATE transaction as its mutation. Takeover can only land
    // between committed stages; the stale owner's next stage is fenced
    // atomically — zero writes, bounded convergence, never a defect.
    const token = claim.claim!;
    const stage = <T>(mutation: () => T) => {
      const r = this.deps.approvals.runFencedExerciseStage(
        approvalId,
        token,
        mutation,
      );
      // R6 — `fenced` (canonical claim verified stale) and `contended`
      // (writer lock never acquired, claim unchecked) both stop this
      // owner's apply for the current tick; the distinction is kept on
      // the result for evidence but both paths converge with zero writes.
      return { ...r, stop: r.fenced || r.contended };
    };

    switch (intent) {
      case "RECOVERY_TASK_ATTEMPT_EXTENSION":
      case LEGACY_RECOVERY_BUDGET_OVERRIDE: {
        // Atomic stage: keyed grant assignment + runtime persist. The
        // exercise id is the provenance — replays write identical values,
        // so the grant can never stack twice.
        if (
          stage(() => {
            const rtS = this.runtimeEntity(missionId);
            const ext =
              (rtS.budget_extension as Record<string, unknown>) ?? {};
            const tasks =
              (ext.tasks as Record<string, Record<string, unknown>>) ?? {};
            tasks[taskId] = {
              attempts_per_task: Number(effect.attempts_per_task ?? 1),
              baseline_attempts: Number(effect.baseline_attempts ?? 0),
              baseline_identical: Number(effect.baseline_identical ?? 0),
              approval_exercise_id: exerciseId,
            };
            rtS.budget_extension = { ...ext, tasks };
            rtS.pending_approval_id = null;
            this.store.put(
              "mission_runtime",
              String(rtS.mission_runtime_id),
              rtS,
              Number(rtS.version),
            );
          }).stop
        ) {
          return;
        }
        if (waiting) {
          // Atomic stage: approval-driven transition.
          if (
            stage(() =>
              this.transitionRuntime(
                missionId,
                "RECOVERING",
                "approval_exercised_attempt_extension",
              ),
            ).stop
          ) {
            return;
          }
        }
        // A FRESH governed decide() applies the widened per-task ceiling —
        // replaying the stale pending action would just re-mint the same
        // approval (bounded abort). The new decision replaces the stale
        // pending_recovery; stale scheduled actions are swept first. A
        // terminal mission cannot run a chain — converge only.
        if (!terminal) {
          this.resumeExercisedChain(
            missionId,
            taskId,
            exerciseId,
            now,
            effect,
            stage,
          );
        }
        break;
      }
      case "RECOVERY_OPERATOR_REVALIDATION": {
        // Atomic stage: runtime persist (approval linkage cleared).
        if (
          stage(() => {
            const rtS = this.runtimeEntity(missionId);
            rtS.pending_approval_id = null;
            this.store.put(
              "mission_runtime",
              String(rtS.mission_runtime_id),
              rtS,
              Number(rtS.version),
            );
          }).stop
        ) {
          return;
        }
        // Approval = "operator reviewed this escalation" — the effect is
        // a fresh bounded re-decision; the failure itself is unchanged.
        // If nothing actually changed, the same signature re-escalates
        // once and is bounded (§7), never an approval loop.
        if (waiting) {
          if (
            stage(() =>
              this.transitionRuntime(
                missionId,
                "RECOVERING",
                "approval_exercised_revalidation",
              ),
            ).stop
          ) {
            return;
          }
        }
        if (!terminal) {
          this.resumeExercisedChain(
            missionId,
            taskId,
            exerciseId,
            now,
            effect,
            stage,
          );
        }
        break;
      }
      case "ACKNOWLEDGE_UNKNOWN_SIDE_EFFECT_NO_REPLAY": {
        // §5 — explicit no-replay acknowledgment, decomposed into atomic
        // fenced stages: takeover between any two stages leaves the
        // committed ones valid, and the new owner resumes idempotently.
        // The task is NEVER re-dispatched/re-routed on this approval.
        const barriers =
          (rt.barriers as Record<string, Record<string, unknown>>) ?? {};
        const barrierExecId = barriers[taskId]?.execution_id
          ? String(barriers[taskId].execution_id)
          : null;
        // Atomic stage: barrier settlement keyed to this exercise.
        if (
          stage(() => {
            const rtS = this.runtimeEntity(missionId);
            const bars =
              (rtS.barriers as Record<string, Record<string, unknown>>) ??
              {};
            const bar = bars[taskId];
            if (
              bar &&
              String(bar.approval_exercise_id ?? "") !== exerciseId
            ) {
              bar.settled = true;
              bar.operator_outcome = "OPERATOR_ACCEPTED_UNKNOWN_NO_REPLAY";
              bar.approval_exercise_id = exerciseId;
              rtS.barriers = bars;
              this.store.put(
                "mission_runtime",
                String(rtS.mission_runtime_id),
                rtS,
                Number(rtS.version),
              );
            }
          }).stop
        ) {
          return;
        }
        // Atomic stage: task terminalization.
        if (
          taskId &&
          stage(() => {
            const task = this.store.tryGet("task", taskId);
            if (task && String(task.status) !== "FAILED") {
              this.deps.service.updateTask(taskId, { status: "FAILED" });
            }
          }).stop
        ) {
          return;
        }
        // Atomic stage: neutralize the execution row — the operator
        // outcome is durable so RUNNING's in-flight sweep can never
        // re-drive it into recovery after restart (replay impossible
        // even though execution_state stays UNKNOWN, receipt preserved).
        if (
          barrierExecId &&
          stage(() => {
            const exec = this.store.tryGet(
              "executor_execution",
              barrierExecId,
            );
            if (
              exec &&
              String(exec.terminal_outcome ?? "") !==
                "OPERATOR_ACCEPTED_UNKNOWN_NO_REPLAY"
            ) {
              exec.terminal_outcome = "OPERATOR_ACCEPTED_UNKNOWN_NO_REPLAY";
              this.store.put(
                "executor_execution",
                barrierExecId,
                exec,
                Number(exec.version),
              );
            }
          }).stop
        ) {
          return;
        }
        // Atomic stage: pending recovery neutralization.
        if (
          stage(() =>
            this.clearPendingRecovery(
              missionId,
              "CANCELLED",
              "operator_no_replay",
            ),
          ).stop
        ) {
          return;
        }
        // Atomic stage: approval linkage clear + resume transition.
        if (
          stage(() => {
            const rt3 = this.runtimeEntity(missionId);
            rt3.pending_approval_id = null;
            this.store.put(
              "mission_runtime",
              String(rt3.mission_runtime_id),
              rt3,
              Number(rt3.version),
            );
            if (waiting) {
              this.transitionRuntime(
                missionId,
                "RUNNING",
                "approval_exercised_no_replay",
              );
            }
          }).stop
        ) {
          return;
        }
        break;
      }
      default: {
        if (
          stage(() => {
            const rtS = this.runtimeEntity(missionId);
            rtS.pending_approval_id = null;
            this.store.put(
              "mission_runtime",
              String(rtS.mission_runtime_id),
              rtS,
              Number(rtS.version),
            );
          }).stop
        ) {
          return;
        }
        if (waiting) {
          if (
            stage(() =>
              this.transitionRuntime(
                missionId,
                "RUNNING",
                "approval_granted_resume",
              ),
            ).stop
          ) {
            return;
          }
        }
      }
    }
    // Lifecycle close — the whole effect is durable. A crash anywhere
    // above leaves APPLYING owned by this instance; the next claim
    // (self or a post-lease takeover) re-enters and re-applies the same
    // idempotent writes until this line runs. Fenced by the claim token:
    // a stale owner cannot land APPLIED for a row it no longer owns.
    // `contended` (writer lock) is bounded — the next tick retries.
    this.deps.approvals.markExercisedApplied(
      approvalId,
      token.owner_id,
      token.claim_epoch,
    );
  }

  /** Deterministic effect plan for an approval exercise — persisted on
   *  the APRE row by the winner so a crash-restart resumes the SAME plan
   *  instead of recomputing baselines that have since drifted. The
   *  `stale_recovery` snapshot is the chain the exercise replaces: a
   *  crash between clearing it and minting the fresh decide rebuilds
   *  from this plan verbatim — never recomputes. */
  private exerciseEffectPlan(
    missionId: string,
    approval: Record<string, unknown>,
    intent: string,
    taskId: string,
  ): Record<string, unknown> {
    const stale = (this.runtimeEntity(missionId).pending_recovery ??
      null) as Record<string, unknown> | null;
    const plan: Record<string, unknown> = {
      stale_recovery: stale
        ? {
            task_id: stale.task_id ?? null,
            execution_id: stale.execution_id ?? null,
            failure_class: stale.failure_class ?? null,
            infeasible_actions: stale.infeasible_actions ?? null,
            recovery_id: stale.recovery_id ?? null,
          }
        : null,
    };
    if (
      intent === "RECOVERY_TASK_ATTEMPT_EXTENSION" ||
      intent === LEGACY_RECOVERY_BUDGET_OVERRIDE
    ) {
      const intentRow =
        (approval.intent as Record<string, unknown> | null) ?? {};
      const grant =
        Number(
          ((intentRow.grant as Record<string, unknown> | undefined) ?? {})
            .attempts_per_task,
        ) || 1;
      // Anchor the grant to attempts consumed so far: the escalation
      // decision that minted this approval is itself a recovery_attempt,
      // so a relative ceiling would never yield another dispatch.
      const taskAttempts = this.store
        .list("recovery_attempt")
        .filter((a) => String(a.task_id) === taskId);
      // The grant also re-arms the consecutive-identical ceiling for the
      // exact signature being extended — otherwise the second guard eats
      // the granted attempt before any dispatch.
      const grantSignature = String(intentRow.failure_signature ?? "");
      let identical = 0;
      for (const a of [...taskAttempts].sort(
        (x, y) => Number(y.attempt_no ?? 0) - Number(x.attempt_no ?? 0),
      )) {
        if (String(a.failure_signature ?? "") !== grantSignature) break;
        identical += 1;
      }
      plan.attempts_per_task = grant;
      plan.baseline_attempts = taskAttempts.length;
      plan.baseline_identical = identical;
    }
    return plan;
  }

  /** After an exercised approval, replace the stale pending chain with a
   *  fresh governed decide() — stamped with the exercise id so a
   *  restart/re-entry re-finds the already-minted chain and NEVER mints a
   *  second decision for the same exercise (R1: REVALIDATION re-entry
   *  bound). When the pre-exercise chain was already cleared by a crash
   *  before the fresh decide, `plan.stale_recovery` (persisted on the
   *  APRE row) rebuilds the same chain deterministically. */
  private resumeExercisedChain(
    missionId: string,
    taskId: string,
    exerciseId: string,
    now?: string,
    plan?: Record<string, unknown>,
    stage?: <T>(mutation: () => T) => { fenced: boolean; stop?: boolean },
  ): void {
    const planHasSnapshot =
      plan != null &&
      Object.prototype.hasOwnProperty.call(plan, "stale_recovery");
    const planStale =
      (plan?.stale_recovery as Record<string, unknown> | null) ?? null;
    const planChainId = planStale
      ? String(planStale.recovery_id ?? "")
      : null;
    if (!stage) return;
    const rt = this.runtimeEntity(missionId);
    const pending = rt.pending_recovery as Record<string, unknown> | null;
    if (
      pending &&
      String(pending.approval_exercise_id ?? "") === exerciseId
    ) {
      return; // chain for this exercise already minted — resume it
    }
    if (
      pending &&
      planHasSnapshot &&
      String(pending.recovery_id ?? "") !== String(planChainId ?? "")
    ) {
      // R4 — the previous owner minted this chain durably but was fenced
      // before stamping it: its recovery_id differs from the snapshot's
      // stale chain, so it IS the fresh exercise chain. Adopt it verbatim
      // instead of minting a second recovery_decision for this APRE.
      // Plans without the snapshot key (pre-R4 winners) cannot prove the
      // distinction — fall through to the conservative clear+rebuild.
      // Atomic stage: stamp + persist, atomically owned.
      stage(() => {
        const rtS = this.runtimeEntity(missionId);
        const cur = rtS.pending_recovery as Record<string, unknown> | null;
        if (cur) {
          cur.approval_exercise_id = exerciseId;
          rtS.pending_recovery = cur;
          this.store.put(
            "mission_runtime",
            String(rtS.mission_runtime_id),
            rtS,
            Number(rtS.version),
          );
        }
      });
      return;
    }
    // Atomic stage: clear the stale pending chain.
    if (
      stage(() =>
        this.clearPendingRecovery(missionId, "COMPLETED", "approval_exercised"),
      ).stop
    ) {
      return;
    }
    const stale = pending ?? planStale;
    if (!stale) return;
    // Atomic stage (§7 critical): recovery decision mint AND the
    // approval_exercise_id stamp inside ONE transaction — a competing
    // takeover cannot land between mint and stamp, so no window exists
    // for a stale mint followed by a stale stamp.
    stage(() => {
      this.startRecovery(
        missionId,
        taskId || String(stale.task_id),
        stale.execution_id ? String(stale.execution_id) : null,
        stale.failure_class as ReturnType<typeof classifyFailure>,
        now,
        undefined,
        stale.infeasible_actions as
          | Array<{ action: RecoveryAction; reason: string }>
          | undefined,
      );
      const rtAfter = this.runtimeEntity(missionId);
      const fresh = rtAfter.pending_recovery as
        | Record<string, unknown>
        | null;
      if (fresh) {
        fresh.approval_exercise_id = exerciseId;
        this.store.put(
          "mission_runtime",
          String(rtAfter.mission_runtime_id),
          rtAfter,
          Number(rtAfter.version),
        );
      }
    });
  }

  private clearPendingRecovery(
    missionId: string,
    scheduledStatus: "COMPLETED" | "CANCELLED",
    reason: string,
  ): void {
    const rt = this.runtimeEntity(missionId);
    const pending = rt.pending_recovery as Record<string, unknown> | null;
    if (pending) {
      for (const a of this.store.list("scheduled_action")) {
        if (
          a.recovery_id === pending.recovery_id &&
          (a.status === "RUNNING" || a.status === "READY" || a.status === "SCHEDULED")
        ) {
          this.deps.scheduler.markScheduledAction(String(a.scheduled_action_id), scheduledStatus);
        }
      }
    }
    rt.pending_recovery = null;
    rt.pending_remediation = null;
    rt.reason = reason;
    this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
  }

  /* ---------------- RECONCILING ------------------------------------------- */

  private runReconciliation(missionId: string): void {
    const rt = this.runtimeEntity(missionId);
    const barriers = (rt.barriers as Record<string, Record<string, unknown>>) ?? {};
    const entries = Object.entries(barriers).filter(([, b]) => b.kind === "RECONCILIATION" && !b.settled);
    if (entries.length === 0) {
      this.transitionRuntime(missionId, "RUNNING", "reconciliation_settled");
      return;
    }
    for (const [taskId, barrier] of entries) {
      const receipt = this.deps.reconciliation.reconcile({
        execution_id: barrier.execution_id ? String(barrier.execution_id) : undefined,
        governed_task_id: barrier.governed_task_id
          ? String(barrier.governed_task_id)
          : undefined,
        mission_id: missionId,
        correlation_id: `${missionId}:${taskId}`,
      });
      const outcome = String(receipt.outcome);
      barrier.last_receipt_id = receipt.reconciliation_id ?? receipt.receipt_id;
      barrier.last_outcome = outcome;
      switch (outcome) {
        case "CONFIRMED_NOT_EXECUTED": {
          barrier.settled = true;
          this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
          // Safe redrive permitted — recovery re-decides.
          const pending = rt.pending_recovery;
          if (pending) {
            this.transitionRuntime(missionId, "RECOVERING", "reconcile_not_executed");
          } else {
            this.transitionRuntime(missionId, "RUNNING", "reconcile_not_executed");
          }
          return;
        }
        case "CONFIRMED_RUNNING": {
          barrier.settled = true;
          this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
          this.transitionRuntime(missionId, "RUNNING", "reconcile_running");
          return;
        }
        case "CONFIRMED_COMPLETED": {
          barrier.settled = true;
          this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
          const execId = String(barrier.execution_id ?? "");
          if (execId) this.settleExecution(missionId, execId);
          this.transitionRuntime(missionId, "RUNNING", "reconcile_completed");
          return;
        }
        case "CONFIRMED_FAILED": {
          barrier.settled = true;
          this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
          const execId = String(barrier.execution_id ?? "");
          if (execId) this.settleExecution(missionId, execId);
          this.transitionRuntime(missionId, "RECOVERING", "reconcile_failed");
          return;
        }
        case "UNKNOWN_SIDE_EFFECT_STATE":
        default: {
          // Phase D §5 — never auto-replay. The approval carries the
          // explicit no-replay acknowledgment intent: APPROVED means
          // "operator accepts this work cannot be replayed" and settles
          // the barrier + task terminally — never a retry or re-route.
          this.mintRecoveryApproval(missionId, taskId, {
            intent: "ACKNOWLEDGE_UNKNOWN_SIDE_EFFECT_NO_REPLAY",
            reason: "unknown side-effect state — blind replay forbidden",
            risk_class: "HIGH",
            failure_signature: `UNKNOWN_SIDE_EFFECT_STATE::${String(
              barrier.executor_id ?? "any",
            )}::any`,
            recovery_decision_id:
              ((rt.pending_recovery as Record<string, unknown> | null)
                ?.recovery_id as string | undefined) ?? null,
            execution_id: barrier.execution_id
              ? String(barrier.execution_id)
              : null,
          });
          return;
        }
      }
    }
  }

  /* ---------------- REPLANNING -------------------------------------------- */

  /**
   * F3 §26 — bounded replan: at most MAX_REPLAN_CANDIDATES_PER_DECISION
   * candidates per recovery decision, each persisted to the durable
   * replan_attempt ledger BEFORE the next is requested, and every check
   * (proposal validity, artifact/dataflow feasibility, semantic
   * duplicate vs the failed plan + prior rejected candidates) resolves
   * BEFORE the old plan is touched (no task cancels, no approval/timer
   * supersede, no commit). A duplicate or infeasible candidate consumes
   * its slot; the next planner request carries the rejected digests so
   * a semantic re-emission cannot spend the remaining slot on the same
   * plan shape. Exhaustion does NOT retry — the REPLAN action itself is
   * marked infeasible and a FRESH RecoveryController decision picks the
   * next matrix action (DEPENDENCY_FAILURE → ABORT).
   */
  private runReplan(missionId: string): void {
    const mission = this.deps.service.getMission(missionId);
    if (!this.deps.planner) {
      throw new PolicyError("FAIL_CLOSED_NO_PLANNER", missionId);
    }
    const rt = this.runtimeEntity(missionId);
    const pending = (rt.pending_recovery ?? undefined) as
      | Record<string, unknown>
      | undefined;
    const recoveryId = String(pending?.recovery_id ?? "");
    const pendingCtx = pending?.failure_context as
      | RecoveryFailureContext
      | undefined;
    const advice = this.adviseSafely(mission);
    const oldPlanId = String(mission.plan_id ?? "");
    const allTasks = this.deps.service.listTasks(missionId);
    const oldTasks = allTasks.filter((t) => t.plan_id === oldPlanId);
    const allTaskRows = allTasks as Array<Record<string, unknown>>;
    // Failed-plan semantic authority: the pending failure context carries
    // it when the failure was structured; otherwise recompute from the
    // committed task rows (pre-F3 revisions carry the same meaning).
    const failedDigest =
      pendingCtx?.plan_semantic_digest ??
      persistedPlanSemanticDigest({
        store: this.store,
        mission,
        tasks: allTaskRows,
      });
    const ledger = new ReplanAttemptLedger(this.store);
    const rejectedDigests = new Set(
      ledger.rejectedCandidateDigests(recoveryId),
    );
    const forbidden = new Set<string>([
      ...(failedDigest ? [failedDigest] : []),
      ...rejectedDigests,
    ]);
    const knownCaps = new Set(
      this.store.list("capability").map((c) => String(c.capability_id)),
    );
    const decisionRow = recoveryId
      ? (this.store.tryGet("recovery_decision", recoveryId) as
          | Record<string, unknown>
          | null)
      : null;
    const failedTaskKey =
      pendingCtx?.task_key ??
      (() => {
        const t = allTaskRows.find(
          (x) => String(x.task_id) === String(pending?.task_id ?? ""),
        );
        return t?.task_key != null ? String(t.task_key) : null;
      })();

    /* R1.3 — crash-safe candidate protocol. One shared seam commits a
     * durably-prepared candidate: the exact canonical task contract is
     * read from the PREPARED ledger row (never a re-planned candidate),
     * the plan revision commits BEFORE the old plan mutates (a crash
     * between leaves "old plan intact + candidate prepared"), the
     * attempt flips ACCEPTED only with a durable commit receipt bound
     * to the plan revision, and supersession/finalize converges
     * idempotently on replay. */
    const commitCandidate = (prepared: ReplanAttemptRecord): void =>
      this.commitPreparedReplan(missionId, prepared, ledger);

    // A durably-prepared candidate finishes its EXACT commit first —
    // no planner call, no replacement candidate, never a second commit.
    const pendingPrepared = ledger.pendingPrepared(recoveryId);
    if (pendingPrepared.length > 1) {
      throw new IntegrityError(
        "FAIL_CLOSED_REPLAN_ATTEMPT_STATE",
        `${recoveryId}:multiple_prepared`,
      );
    }
    if (pendingPrepared.length === 1) {
      commitCandidate(pendingPrepared[0]);
      return;
    }

    while (
      ledger.attemptsUsed(recoveryId) < MAX_REPLAN_CANDIDATES_PER_DECISION
    ) {
      const attemptIndex = ledger.attemptsUsed(recoveryId);
      let proposal: unknown;
      try {
        proposal = this.deps.planner({
          mission,
          advice: advice ?? null,
          superseded_tasks: oldTasks,
          reason: "replan",
          replan_context: {
            recovery_id: recoveryId,
            failure_signature:
              decisionRow?.failure_signature != null
                ? String(decisionRow.failure_signature)
                : null,
            failure_class: String(pending?.failure_class ?? ""),
            dependency_reason: pendingCtx?.dependency_reason ?? null,
            failed_task_key: failedTaskKey,
            failed_plan_semantic_digest: failedDigest,
            rejected_semantic_digests: [...rejectedDigests],
          },
        });
      } catch (err) {
        const code = String((err as { code?: string })?.code ?? "");
        // R1.1 — the REPLAN action itself is infeasible when no governed
        // replan provider can produce a candidate: not a candidate
        // rejection, no bounded slot consumed — route straight to the
        // exhaustion path so a fresh RecoveryController decision picks
        // the next matrix action.
        if (code.startsWith("FAIL_CLOSED_REPLAN_PROVIDER")) break;
        throw err;
      }
      let tasks: Array<Record<string, unknown>> | null = null;
      let candidateDigest: string | null = null;
      let status:
        | "REJECTED_DUPLICATE"
        | "REJECTED_FEASIBILITY"
        | "REJECTED_INVALID"
        | null = null;
      let rejectionReason: string | null = null;
      try {
        const validated = validatePlanProposal(proposal, knownCaps);
        // Same data-flow + delivery plan-shape proof as the initial plan
        // (R1/R8) — feasibility for candidate accounting is structural.
        assertPlanDataflow(
          validated as unknown as Array<Record<string, unknown>>,
          {
            telegramIntent: detectTelegramDeliveryIntent(mission.goal),
            outputLanguage: detectOutputLanguage(mission.goal),
          },
        );
        tasks = validated as unknown as Array<Record<string, unknown>>;
        candidateDigest = canonicalPlanSemanticDigest(tasks);
        if (forbidden.has(candidateDigest)) {
          status = "REJECTED_DUPLICATE";
          rejectionReason = "PLAN_SEMANTIC_DUPLICATE";
        }
      } catch (err) {
        const code = String(
          (err as { code?: string })?.code ?? "PLAN_REJECTED",
        );
        status =
          code === "FAIL_CLOSED_PLAN_FEASIBILITY" ||
          code.startsWith("FAIL_CLOSED_PLAN_DATAFLOW")
            ? "REJECTED_FEASIBILITY"
            : "REJECTED_INVALID";
        rejectionReason = code;
        // The semantic digest of a rejected candidate still binds its
        // shape when computable — an identical semantic re-emission is
        // caught even when the rejection was for validity, not dataflow.
        try {
          const raw = (proposal as { tasks?: unknown[] })?.tasks;
          if (Array.isArray(raw)) {
            candidateDigest = canonicalPlanSemanticDigest(
              raw as Array<Record<string, unknown>>,
            );
          }
        } catch {
          candidateDigest = null;
        }
      }
      if (status !== null) {
        // Persist rejection BEFORE advancing candidates — durable
        // evidence; a crash replays the same bounded slot.
        ledger.record({
          mission_id: missionId,
          recovery_id: recoveryId,
          failure_signature:
            decisionRow?.failure_signature != null
              ? String(decisionRow.failure_signature)
              : null,
          failed_plan_semantic_digest: failedDigest,
          attempt_index: attemptIndex,
          proposal_digest: digest(proposal),
          candidate_plan_semantic_digest: candidateDigest,
          status,
          rejection_reason: rejectionReason,
        });
        if (candidateDigest) {
          rejectedDigests.add(candidateDigest);
          forbidden.add(candidateDigest);
        }
        continue;
      }
      // PREPARED — the exact candidate (canonical validated tasks + raw
      // proposal + superseded plan) is durable BEFORE any commit or any
      // old-plan mutation; commitCandidate then finishes it atomically-
      // convergent (commit → receipt → supersede → clear).
      const preparedRow = ledger.record({
        mission_id: missionId,
        recovery_id: recoveryId,
        failure_signature:
          decisionRow?.failure_signature != null
            ? String(decisionRow.failure_signature)
            : null,
        failed_plan_semantic_digest: failedDigest,
        attempt_index: attemptIndex,
        proposal_digest: digest(proposal),
        candidate_plan_semantic_digest: candidateDigest,
        prepared_tasks: tasks,
        prepared_proposal: proposal,
        superseded_plan_id: oldPlanId,
        status: "PREPARED",
      });
      commitCandidate(preparedRow);
      return;
    }

    // Candidates exhausted — the REPLAN action is itself infeasible for
    // this failure chain; a FRESH RecoveryController decision picks the
    // next valid action (never another same-signature replan loop).
    const priorInfeasible =
      (pending?.infeasible_actions as
        | Array<{ action: RecoveryAction; reason: string }>
        | undefined) ?? [];
    this.startRecovery(
      missionId,
      String(pending?.task_id ?? ""),
      pending?.execution_id != null ? String(pending.execution_id) : null,
      (pending?.failure_class as ReturnType<typeof classifyFailure>) ??
        "DEPENDENCY_FAILURE",
      undefined,
      undefined,
      [
        ...priorInfeasible.filter((e) => e.action !== "REPLAN"),
        { action: "REPLAN", reason: "FAIL_CLOSED_REPLAN_CANDIDATES_EXHAUSTED" },
      ],
      { failure_context: pendingCtx ?? null },
    );
  }

  /* F3 R1.3 + R2 — crash-safe replan commit with EXACT attempt-bound
   * receipt authority. The passed attempt row may be stale (a slower
   * writer may have committed already), so the row is RE-READ inside
   * the writer-serialized transaction:
   *   ACCEPTED → verify the exact attempt-bound receipt → converge
   *   (the committing transaction already landed supersession + clear
   *   + READY atomically — zero writes needed).
   *   PREPARED → find a revision bound to THIS attempt
   *   (pair-replan-commit.v1: recovery + attempt + superseded +
   *   mission + semantic digest — NEVER a digest scan over history)
   *   or commit the prepared candidate exactly once. */
  private commitPreparedReplan(
    missionId: string,
    prepared: ReplanAttemptRecord,
    ledger: ReplanAttemptLedger,
  ): void {
    // ONE atomic transaction (BEGIN IMMEDIATE … COMMIT): commit +
    // receipt + old-plan supersession + pending clear + READY land
    // together or not at all. A crash inside rolls back EVERYTHING
    // except the already-durable PREPARED row.
    this.store.immediate(() => {
      const fresh = this.store.tryGet(
        "replan_attempt",
        prepared.replan_attempt_id,
      ) as ReplanAttemptRecord | null;
      if (!fresh) {
        throw new IntegrityError(
          "FAIL_CLOSED_REPLAN_ATTEMPT_MISSING",
          prepared.replan_attempt_id,
        );
      }
      const revisions = () => this.store.planRevisions(missionId);
      if (fresh.status === "ACCEPTED") {
        // §5/§8 — converge ONLY through exact attempt-bound evidence:
        // the receipt must name a revision bound to THIS attempt.
        assertReplanCommitReceipt(revisions(), fresh);
        return;
      }
      if (fresh.status !== "PREPARED") {
        throw new IntegrityError(
          "FAIL_CLOSED_REPLAN_ATTEMPT_SLOT_CONFLICT",
          `${fresh.replan_attempt_id}:${fresh.status}`,
        );
      }
      // §3 — exact attempt-bound binding; semantic digest alone is
      // never a commit receipt (a historical revision may share the
      // candidate's semantics yet belong to no recovery/attempt).
      let bound =
        revisions().find((r) => revisionBoundToAttempt(r, fresh)) ?? null;
      if (!bound) {
        const res = this.deps.service.commitPlan({
          mission_id: missionId,
          tasks: (fresh.prepared_tasks ??
            []) as Array<Record<string, unknown>>,
          source: "AUTOMATON_PLANNER",
          reason: "replan",
          proposal:
            fresh.prepared_proposal ?? { tasks: fresh.prepared_tasks },
          replan_commit: {
            recovery_id: fresh.recovery_id,
            replan_attempt_id: fresh.replan_attempt_id,
            superseded_plan_id: String(fresh.superseded_plan_id ?? ""),
          },
        });
        // §7 — prove what was persisted equals the prepared candidate:
        // a commit transformation is an integrity violation.
        if (
          String(res.plan_semantic_digest) !==
          String(fresh.candidate_plan_semantic_digest)
        ) {
          throw new IntegrityError(
            "FAIL_CLOSED_REPLAN_COMMIT_DIGEST",
            `${fresh.replan_attempt_id}:${res.plan_id}`,
          );
        }
        bound =
          revisions().find(
            (r) =>
              String(r.plan_id) === String(res.plan_id) &&
              Number(r.revision) === Number(res.revision),
          ) ?? null;
        if (!bound || !revisionBoundToAttempt(bound, fresh)) {
          throw new IntegrityError(
            "FAIL_CLOSED_REPLAN_COMMIT_RECEIPT",
            `${fresh.replan_attempt_id}:${res.plan_id}@${res.revision}`,
          );
        }
      }
      ledger.markCommitted(fresh.replan_attempt_id, {
        plan_id: String(bound.plan_id),
        revision: Number(bound.revision),
        plan_semantic_digest: String(bound.plan_semantic_digest),
      });
      // Old-plan supersession — deterministic and idempotent; runs only
      // after the new plan revision provably exists.
      const supersededPlanId = String(fresh.superseded_plan_id ?? "");
      for (const t of this.deps.service.listTasks(missionId)) {
        if (
          String(t.plan_id) === supersededPlanId &&
          !SETTLED_TASK.has(String(t.status))
        ) {
          this.deps.service.updateTask(String(t.task_id), {
            status: "CANCELLED",
            cancel_reason: "PLAN_SUPERSEDED",
          });
        }
      }
      this.deps.approvals.supersede(missionId, undefined, "PLAN_SUPERSEDED");
      this.deps.scheduler.supersedePending(missionId, "PLAN_SUPERSEDED");
      this.clearPendingRecovery(missionId, "CANCELLED", "replan_committed");
      this.transitionRuntime(missionId, "READY", "replan_committed");
    });
  }

  /* ---------------- WAITING_APPROVAL -------------------------------------- */

  /**
   * Phase D §4 — every approval status must converge: PENDING waits,
   * APPROVED applies exactly-once via durable exercise, DENIED/EXPIRED
   * are bounded terminal, SUPERSEDED relinks to a surviving PENDING
   * recovery request for this mission or goes bounded terminal. The TTL
   * sweep runs before the read — `get()` alone never expires a stale
   * PENDING, so a runtime that polls only `get()` would wait forever on
   * an already-dead request.
   */
  private checkPendingApproval(missionId: string, now?: string): void {
    // Canonical runtime time drives expiry — never the wall clock.
    this.deps.approvals.expireSweep(now);
    const rt = this.runtimeEntity(missionId);
    const approvalId = rt.pending_approval_id as string | null;
    if (!approvalId) {
      this.transitionRuntime(missionId, "RUNNING", "no_pending_approval");
      return;
    }
    const approval = this.deps.approvals.get(approvalId);
    const status = String(approval.status);
    if (status === "PENDING") return; // still waiting
    if (status === "SUPERSEDED") {
      // R1 — relink only to an approval EQUIVALENT to the superseded
      // chain: same mission + task + type + action + failure signature.
      // Prefer a candidate carrying the same recovery-decision identity
      // when several match. Never relink across tasks or intents; if no
      // exact equivalent survives, the mission goes bounded terminal.
      const sigOf = (a: Record<string, unknown>) =>
        String(
          (a.intent as Record<string, unknown> | null)?.failure_signature ??
            (a.scope_snapshot as Record<string, unknown> | null)
              ?.failure_signature ??
            "",
        );
      const wantSig = sigOf(approval);
      const wantDecision = String(
        (approval.intent as Record<string, unknown> | null)
          ?.recovery_decision_id ??
          (approval.scope_snapshot as Record<string, unknown> | null)
            ?.recovery_decision_id ??
          "",
      );
      const equivalents = this.deps.approvals
        .listPending(missionId)
        .filter(
          (a) =>
            a.approval_type === approval.approval_type &&
            a.requested_action === approval.requested_action &&
            String(a.task_id ?? "") === String(approval.task_id ?? "") &&
            sigOf(a) === wantSig,
        );
      const replacement =
        equivalents.find(
          (a) =>
            String(
              (a.intent as Record<string, unknown> | null)
                ?.recovery_decision_id ??
                (a.scope_snapshot as Record<string, unknown> | null)
                  ?.recovery_decision_id ??
                "",
            ) === wantDecision,
        ) ?? (equivalents.length === 1 ? equivalents[0] : null);
      rt.pending_approval_id = replacement
        ? String(replacement.approval_id)
        : null;
      this.store.put(
        "mission_runtime",
        String(rt.mission_runtime_id),
        rt,
        Number(rt.version),
      );
      if (!replacement) {
        this.abortMission(missionId, "approval_superseded");
      }
      return;
    }
    if (status === "DENIED" || status === "EXPIRED") {
      rt.pending_approval_id = null;
      this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
      this.abortMission(missionId, `approval_${status.toLowerCase()}`);
      return;
    }
    if (status === "APPROVED") {
      this.exerciseApprovedRecovery(missionId, approvalId, now);
      return;
    }
  }

  /** Advisory retrieval — a broken advisor can never break orchestration. */
  private adviseSafely(mission: Record<string, unknown>) {
    try {
      return this.deps.plannerAdvisor?.advise({
        goal: String(mission.goal),
        mission_id: String(mission.mission_id),
        environment: this.deps.environment,
      }) ?? null;
    } catch {
      return null;
    }
  }

  /* ---------------- terminal ---------------------------------------------- */

  private maybeComplete(missionId: string): void {
    const mission = this.deps.service.getMission(missionId);
    if (mission.plan_id == null) return;
    const { plan_id } = this.deps.service.activeRevision(missionId);
    const tasks = this.deps.service
      .listTasks(missionId)
      .filter((t) => t.plan_id === plan_id);
    if (tasks.length === 0) return;
    const allTerminal = tasks.every((t) => SETTLED_TASK.has(String(t.status)));
    if (!allTerminal) return;
    const inFlight = this.store
      .list("executor_execution")
      .filter(
        (e) =>
          e.mission_id === missionId &&
          !TERMINAL_EXECUTION.has(String(e.execution_state)) &&
          !e.terminal_outcome, // Phase D §5 — operator-neutralized
      );
    if (inFlight.length > 0) return;

    const failed = tasks.filter((t) => String(t.status) !== "COMPLETED");
    if (failed.length === 0) {
      this.deps.service.transitionMission(missionId, "COMPLETED", this.actor);
      this.transitionRuntime(missionId, "COMPLETED", "all_tasks_completed");
    } else {
      this.deps.service.transitionMission(missionId, "FAILED", this.actor);
      this.transitionRuntime(missionId, "FAILED", `tasks_incomplete:${failed.map((t) => t.task_id).join(",")}`);
    }
  }

  private abortMission(missionId: string, reason: string): void {
    const mission = this.deps.service.getMission(missionId);
    const allowed = ["READY", "RUNNING", "PAUSED"];
    if (allowed.includes(String(mission.status))) {
      this.deps.service.transitionMission(missionId, "FAILED", this.actor);
    }
    const rt = this.runtimeEntity(missionId);
    const legal = RUNTIME_TRANSITIONS[String(rt.state) as MissionRuntimeState] ?? [];
    if (legal.includes("ABORTED")) {
      this.transitionRuntime(missionId, "ABORTED", reason);
    } else if (String(rt.state) !== "ABORTED") {
      rt.state = "ABORTED";
      rt.reason = reason;
      this.store.put("mission_runtime", String(rt.mission_runtime_id), rt, Number(rt.version));
    }
  }
}

function rt_pendingRemediation(rt: Record<string, unknown>): boolean {
  return rt.pending_remediation != null;
}
