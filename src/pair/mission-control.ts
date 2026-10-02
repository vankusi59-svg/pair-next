/**
 * P9 MissionControl — operator-facing read models + actions.
 *
 * Every action delegates to the canonical authority (MissionRuntime,
 * ApprovalQueue, ReconciliationService, SelfImprovementController,
 * MissionSupervisor). This layer never mutates a DB row directly and never
 * exposes credentials or env dumps — only entity projections.
 */

import fs from "node:fs";
import { verifyBrokerCapability } from "./broker-capability.js";
import { registerSensitiveMaterial } from "./sanitizer.js";
import path from "node:path";
import { IntegrityError, NotFoundError, PolicyError } from "./errors.js";
import type { PairControlPlane } from "./service.js";
import type { MissionRuntime } from "./mission-runtime.js";
import type { MissionSupervisor, WakeReason } from "./mission-supervisor.js";
import type { MissionScheduler } from "./mission-scheduler.js";
import type { MissionScheduleService } from "./mission-schedule.js";
import type { ApprovalQueue } from "./approval-queue.js";
import type { ReconciliationService } from "./reconciliation.js";
import type { MissionObservability } from "./mission-observability.js";
import type { SelfImprovementController } from "./self-improvement.js";
import { projectRoutableExecutors } from "./routing-projection.js";
import { projectRoutableModels } from "./model-routable.js";
import { canonicalRiskCeiling, canonicalWorkspacePath, digest, sha256Hex, utcnow } from "./canonical.js";
import { validateWorkOpenBindingById, type StoreRow } from "./work-open-binding.js";
import { validatePlanProposal } from "./proposal.js";
import { assertPlanDataflow } from "./plan-dataflow.js";
import {
  ackTelegramDelivery as ackTelegramDeliveryEntity,
  pendingTelegramDeliveries,
  beginDeliveryAttempt as beginDeliveryAttemptEntity,
  resolveDeliveryAttempt as resolveDeliveryAttemptEntity,
  holdTelegramDelivery as holdTelegramDeliveryEntity,
} from "./telegram-delivery.js";
import {
  assertPreviewWorkspaceAuthority,
  createPlanPreview as persistPlanPreview,
  consumePlanPreview,
  effectiveInputDigest,
  planDigest,
  verifyPlanPreviewForConfirm,
  PREVIEW_ENTITY,
  ATTEMPT_ENTITY,
  RUN_ENTITY,
} from "./plan-preview.js";
import type { PlannerAttemptRecord } from "./planner-pool.js";
import type { RuntimePlanner } from "./mission-runtime.js";

export interface MissionControlDeps {
  service: PairControlPlane;
  runtime: MissionRuntime;
  /** Same planner the runtime uses — required for §4.3 plan preview. */
  planner?: RuntimePlanner;
  /** Advisory retrieval only, mirrors runtime (never authoritative). */
  plannerAdvisor?: { advise(opts: Record<string, unknown>): Record<string, unknown> };
  supervisor: MissionSupervisor;
  scheduler: MissionScheduler;
  approvals: ApprovalQueue;
  reconciliation: ReconciliationService;
  observability: MissionObservability;
  selfmod?: SelfImprovementController;
  /** Recurring mission triggers — cron schedules persisted in pair.db. */
  schedules?: MissionScheduleService;
  /** Runtime-controlled cost halt lever: when this file exists, remote
   *  dispatch is blocked (same effect as PAIR_COST_HALT=1, but flippable
   *  without a restart). */
  costHaltFile?: string;
  /** Phase B: mission_plan_preview TTL in seconds (default 1800). */
  planPreviewTtlSeconds?: number;
}

function requireOperator(operatorId: string | undefined): string {
  if (!operatorId || !operatorId.trim()) {
    throw new PolicyError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", "mission_control");
  }
  return operatorId;
}

export class MissionControl {
  constructor(private readonly deps: MissionControlDeps) {}

  private get store() {
    return this.deps.service.store;
  }

  /* ---------------- read models ------------------------------------------ */

  projects(): Array<Record<string, unknown>> {
    return this.store.list("project");
  }

  missions(): Array<Record<string, unknown>> {
    return this.store.list("mission").map((m) => {
      const rt = this.store.tryGet("mission_runtime", `MRT_${String(m.mission_id)}`);
      return { ...m, runtime_state: rt ? rt.state : null };
    });
  }

  missionDetail(missionId: string) {
    return this.deps.observability.missionSummary(missionId);
  }

  /** Resolves the project outbox dir for a mission — remote executors push
   *  binary deliverables (charts/screenshots) here via POST /api/outbox so
   *  the delivery pipeline (Telegram bridge) can reach them. Unknown mission
   *  → null (fail-closed: no upload lands outside a known project). */
  missionOutboxDir(missionId: string): string | null {
    const m = this.store.tryGet("mission", missionId) as Record<string, unknown> | null;
    if (!m) return null;
    const prj = this.store.tryGet("project", String(m.project_id ?? "")) as
      | Record<string, unknown>
      | null;
    const root = String(prj?.root_location ?? "");
    return root ? path.join(root, "outbox") : null;
  }

  /** Incident R2 §6 — the ONLY telegram file-delivery authority: canonical
   *  `telegram_delivery_request` rows minted when a governed
   *  TELEGRAM_DELIVERY task completes, projected for the bridge with
   *  resolved absolute artifact paths inside the project outbox. The
   *  bridge never scans the outbox itself — a file in outbox/ is storage,
   *  never a send instruction. */
  telegramDeliveries(state?: string): Array<Record<string, unknown>> {
    const pending = pendingTelegramDeliveries(this.store);
    return state ? pending.filter((r) => r.status === state) : pending;
  }

  /** Bridge ack — idempotent flip of ONE manifested artifact (or the TEXT
   *  request) to SENT. Only what the manifest authorized may ack. */
  ackTelegramDelivery(deliveryId: string, artifact?: string) {
    return ackTelegramDeliveryEntity({
      store: this.store,
      deliveryId,
      artifact,
      now: utcnow(),
    });
  }

  /** R3 §7 — explicit transport lifecycle transition for one artifact
   *  (or the TEXT request): QUEUED→SENDING (begin), SENDING→SENT |
   *  QUEUED (definite failure) | UNKNOWN_SIDE_EFFECT (ambiguous), or
   *  request-level UNSENDABLE hold (destination unresolvable / not
   *  allowed). Only legal transitions mutate; all others no-op. */
  transitionTelegramDelivery(
    deliveryId: string,
    input: {
      artifact?: string | null;
      to?: string;
      message_id?: string | number;
      error?: string;
    },
  ) {
    const artifact = input.artifact === undefined ? undefined : input.artifact;
    switch (String(input.to ?? "")) {
      case "SENDING":
        return beginDeliveryAttemptEntity({
          store: this.store,
          deliveryId,
          artifact,
          now: utcnow(),
        });
      case "SENT":
        return resolveDeliveryAttemptEntity({
          store: this.store,
          deliveryId,
          artifact,
          outcome: "SENT",
          messageId: input.message_id,
          now: utcnow(),
        });
      case "FAILED":
        return resolveDeliveryAttemptEntity({
          store: this.store,
          deliveryId,
          artifact,
          outcome: "FAILED",
          error: input.error,
          now: utcnow(),
        });
      case "UNKNOWN":
        return resolveDeliveryAttemptEntity({
          store: this.store,
          deliveryId,
          artifact,
          outcome: "UNKNOWN",
          error: input.error,
          now: utcnow(),
        });
      case "UNSENDABLE":
        return holdTelegramDeliveryEntity({
          store: this.store,
          deliveryId,
          reason: String(input.error ?? "destination_not_allowed"),
          now: utcnow(),
        });
      default:
        throw new PolicyError(
          "FAIL_CLOSED_TELEGRAM_DELIVERY_TRANSITION",
          String(input.to ?? ""),
        );
    }
  }

  missionDag(missionId: string) {
    const tasks = this.deps.service.listTasks(missionId);
    return {
      nodes: tasks.map((t) => ({
        task_id: t.task_id,
        task_key: t.task_key,
        title: t.title,
        status: t.status,
        selected_executor: t.selected_executor,
        plan_id: t.plan_id,
        order: t.order,
      })),
      edges: tasks.flatMap((t) =>
        ((t.depends_on as string[]) ?? []).map((dep) => {
          const depTask = tasks.find((d) => d.task_key === dep);
          return { from: depTask?.task_id ?? dep, to: t.task_id };
        }),
      ),
    };
  }

  /* ---- mission workspace files (read-only, path-clamped) ---------------- */

  private missionWorkspaces(missionId: string): string[] {
    const m = this.store.tryGet("mission", missionId) as Record<string, unknown> | null;
    if (!m) throw new NotFoundError(`mission:${missionId}`);
    const ws = ((m.metadata as Record<string, unknown> | undefined)?.authorized_workspaces ??
      m.authorized_workspaces ??
      []) as string[];
    return ws.map(String).map((w) => path.resolve(w));
  }

  /** List files under the mission's authorized workspaces (recursive). */
  workspaceFiles(missionId: string): { files: Array<Record<string, unknown>> } {
    const out: Array<Record<string, unknown>> = [];
    for (const root of this.missionWorkspaces(missionId)) {
      if (!fs.existsSync(root)) continue;
      const walk = (dir: string) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(p);
          else if (ent.isFile()) {
            const st = fs.statSync(p);
            out.push({
              path: path.relative(root, p),
              workspace: root,
              size: st.size,
              modified_at: st.mtime.toISOString(),
            });
          }
        }
      };
      walk(root);
    }
    return { files: out.sort((a, b) => String(a.path).localeCompare(String(b.path))) };
  }

  /**
   * Read one file inside the mission's authorized workspaces. Fail-closed:
   * rejects `..`/absolute escapes, anything outside a workspace, and non-UTF8
   * content; caps output at 256 KB.
   */
  workspaceFile(missionId: string, relPath: string): Record<string, unknown> {
    if (!relPath || relPath.includes("\0") || path.isAbsolute(relPath)) {
      throw new IntegrityError("FAIL_CLOSED_BAD_PATH", String(relPath).slice(0, 80));
    }
    for (const root of this.missionWorkspaces(missionId)) {
      const resolved = path.resolve(root, relPath);
      if (!resolved.startsWith(root + path.sep) && resolved !== root) continue;
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
      const buf = fs.readFileSync(resolved);
      const MAX = 256 * 1024;
      const content = buf.slice(0, MAX).toString("utf8");
      if (buf.indexOf(0) !== -1) {
        throw new IntegrityError("FAIL_CLOSED_BINARY_FILE", relPath.slice(0, 80));
      }
      return {
        path: relPath,
        workspace: root,
        size: buf.length,
        sha256: sha256Hex(buf),
        truncated: buf.length > MAX,
        content,
      };
    }
    throw new NotFoundError(`workspace_file:${relPath}`);
  }

  /** §4.1 — canonical entity events after `sinceSeq` (hash-verified on read).
   *  Drives the SSE stream; returns latest_seq so cursors don't regress. */
  eventsSince(sinceSeq = 0): { events: Array<Record<string, unknown>>; latest_seq: number } {
    const all = this.store.listEvents();
    const latest = all.length ? Number(all[all.length - 1].seq ?? 0) : sinceSeq;
    return { events: all.filter((e) => Number(e.seq ?? 0) > sinceSeq), latest_seq: latest };
  }

  timeline(missionId: string) {
    return this.deps.observability.missionTimeline(missionId);
  }

  routing() {
    return {
      routable: projectRoutableExecutors(this.deps.service),
      executors: this.store.list("executor"),
      routes: this.store.list("route"),
      bindings: this.store.list("executor_binding"),
    };
  }

  recovery() {
    return {
      decisions: this.store.list("recovery_decision"),
      attempts: this.store.list("recovery_attempt"),
      scheduled: this.store.list("scheduled_action"),
    };
  }

  /** §4.2 — provider projection; credential status is a flag, never a secret. */
  providers() {
    return {
      providers: this.store.list("provider").map((p) => ({
        ...p,
        credential_status: String(p.auth_state) === "AUTH_OK" ? "configured" : "unavailable",
      })),
      qualifications: this.store.list("provider_qualification"),
    };
  }

  /** §4.2 — model evidence catalog projection (Phase A: + canonical roles). */
  models() {
    const roleByModel = new Map(
      this.store
        .list("model_role_assignment")
        .map((r) => [String(r.model_entry_id), r.role ?? null]),
    );
    return {
      models: this.store.list("model_entry").map((m) => ({
        ...m,
        model_role: roleByModel.get(String(m.model_entry_id)) ?? null,
      })),
      bindings: this.store.list("model_binding"),
      qualifications: this.store.list("model_qualification"),
      role_assignments: this.store.list("model_role_assignment"),
    };
  }

  /** §4.2 — routes + bindings + per-binding 13-gate routable projection. */
  routes() {
    return {
      routes: this.store.list("route"),
      model_bindings: this.store.list("model_binding"),
      routable_models: projectRoutableModels(this.deps.service),
      route_decisions: this.store.list("route_decision"),
      routing_decisions: this.store.list("routing_decision"),
    };
  }

  /** §4.2 — 13-gate routable projection for one model entry id. */
  modelRoutable(modelEntryId: string) {
    const model = this.store.tryGet("model_entry", modelEntryId);
    const rows = projectRoutableModels(this.deps.service).filter(
      (r) => r.model_entry_id === modelEntryId,
    );
    return { model, bindings: rows };
  }

  approvals() {
    // Expose `scope` as an alias of the persisted scope_snapshot so API/UI
    // clients can echo it back on decide — the digest check still binds.
    return this.store.list("approval_request").map((a) => ({
      ...a,
      scope:
        (a.scope as Record<string, unknown> | undefined) ??
        (a.scope_snapshot as Record<string, unknown> | undefined),
    }));
  }

  evidence(missionId: string) {
    return this.store
      .list("evidence")
      .filter((e) => e.mission_id === missionId);
  }

  experience() {
    return {
      experiences: this.store.list("experience"),
      advisor_decisions: this.store.list("advisor_decision"),
    };
  }

  selfImprovement() {
    return {
      candidates: this.store.list("selfmod_candidate"),
      validations: this.store.list("selfmod_validation_receipt"),
      promotions: this.store.list("promotion_candidate"),
    };
  }

  health() {
    return this.deps.observability.health();
  }

  metrics() {
    return this.deps.observability.metrics();
  }

  /* ---------------- operator actions -------------------------------------- */

  /**
   * §4.3 plan preview — runs the injected planner + validator on a
   * fabricated mission-shaped input and returns the validated task list
   * with a sha256 digest. Creates NO canonical state.
   */
  previewMission(input: {
    project_id: string;
    goal: string;
    metadata?: Record<string, unknown>;
    granted_permissions?: string[];
    authorized_workspaces?: string[];
    risk_ceiling?: string;
  }): {
    plan: { tasks: Array<Record<string, unknown>> };
    plan_digest: string;
    plan_source: string | null;
    plan_model: string | null;
  } {
    if (!this.deps.planner) {
      throw new PolicyError("FAIL_CLOSED_NO_PLANNER", "mission_control.preview");
    }
    const workspaces = this.normalizeMissionWorkspaces(input);
    // Planner sees only the mission fields it legitimately reads — the same
    // record shape the runtime will later build from the created entity.
    const pseudoMission: Record<string, unknown> = {
      mission_id: "__preview__",
      project_id: input.project_id,
      goal: input.goal,
      metadata: input.metadata ?? {},
      granted_permissions: input.granted_permissions ?? [],
      authorized_workspaces: workspaces,
      risk_ceiling: canonicalRiskCeiling(input.risk_ceiling),
    };
    const proposal = this.deps.planner({ mission: pseudoMission, advice: null, reason: "initial" });
    const knownCaps = new Set(
      this.store.list("capability").map((c) => String(c.capability_id)),
    );
    const tasks = validatePlanProposal(proposal, knownCaps);
    const plan_digest = digest({
      project_id: input.project_id,
      goal: input.goal,
      granted_permissions: input.granted_permissions ?? [],
      authorized_workspaces: workspaces,
      risk_ceiling: canonicalRiskCeiling(input.risk_ceiling),
      tasks,
    });
    return {
      plan: { tasks: tasks as unknown as Array<Record<string, unknown>> },
      plan_digest,
      // Operator-visible provenance of the proposed plan (metadata is
      // operator-supplied; the digest — not this field — is what pins it).
      plan_source: (input.metadata?.plan_source as string | undefined) ?? null,
      plan_model: (input.metadata?.plan_model as string | undefined) ?? null,
    };
  }

  /* ---------------- Phase B — durable pinned plan ------------------------- */

  /**
   * R4 §2/§3 — canonical mission-input normalization seam. A mission input
   * with no explicit workspace authority inherits its project's canonical
   * root_location — resolved ONCE here, before planning/digest, so the
   * effective input is identical across preview, pinned mission_input,
   * confirm replay, and the created mission. An explicit non-empty caller
   * list passes through verbatim; a project without a usable root fails
   * closed (never the literal "undefined"). Explicit values are NOT
   * re-validated here — GovernedTaskGate authorizes them at dispatch.
   */
  private normalizeMissionWorkspaces(input: {
    project_id: string;
    authorized_workspaces?: string[];
  }): string[] {
    const supplied = input.authorized_workspaces;
    if (Array.isArray(supplied) && supplied.length > 0) {
      // R6 — every entry canonicalized through the single workspace seam so
      // the digested/persisted authority is byte-for-byte what the mission
      // will store. Invalid entries fail closed, ordering preserved.
      return supplied.map((w) => canonicalWorkspacePath(w));
    }
    const project = this.store.tryGet("project", String(input.project_id)) as
      | Record<string, unknown>
      | null;
    const root = project?.root_location;
    if (typeof root !== "string" || root.trim() === "") {
      throw new PolicyError(
        "FAIL_CLOSED_NO_AUTHORIZED_WORKSPACE",
        `project:${String(input.project_id)}: no canonical root_location and no authorized_workspaces supplied`,
      );
    }
    return [canonicalWorkspacePath(root)];
  }

  /**
   * §9/§13 — create a durable canonical `mission_plan_preview`: canonicalize
   * the effective input, run the (already failover-executed) task list
   * through the canonical validator, pin digests, persist preview + all
   * planner_attempt evidence in ONE transaction. The RESPONSE is derived
   * from the persisted row — persist A, return A, never a transformed B.
   *
   * `planner` is the failover evidence produced at the API edge
   * (attempts/winner/warnings/caps). When absent (no planner configured —
   * deterministic template path), attempts is empty and winner null.
   */
  createPlanPreview(
    input: {
      project_id: string;
      goal: string;
      metadata?: Record<string, unknown>;
      granted_permissions?: string[];
      authorized_workspaces?: string[];
      risk_ceiling?: string;
      operator_id?: string;
    },
    plannerEvidence?: {
      /** R1 durable-run id — attempts were persisted during failover and
       *  get linked to the preview here (atomically). */
      planner_run_id?: string;
      attempts: PlannerAttemptRecord[];
      winner: PlannerAttemptRecord | null;
      warnings: string[];
      allowed_capabilities?: string[];
      capability_sets?: string[][];
    },
  ): Record<string, unknown> {
    if (!this.deps.planner) {
      throw new PolicyError("FAIL_CLOSED_NO_PLANNER", "mission_control.preview");
    }
    // Foundation V2 invariant also guards the preview seam: a caller-pinned
    // mission_id can never flow through a preview into creation.
    if ((input as { mission_id?: unknown }).mission_id != null) {
      throw new IntegrityError(
        "FAIL_CLOSED_MISSION_ID_PUBLIC",
        "mission_id pinning is internal-only — public mission creation mints its own id",
      );
    }
    const workspaces = this.normalizeMissionWorkspaces(input);
    const risk = canonicalRiskCeiling(input.risk_ceiling);
    const pseudoMission: Record<string, unknown> = {
      mission_id: "__preview__",
      project_id: input.project_id,
      goal: input.goal,
      metadata: input.metadata ?? {},
      granted_permissions: input.granted_permissions ?? [],
      authorized_workspaces: workspaces,
      risk_ceiling: risk,
    };
    const proposal = this.deps.planner({ mission: pseudoMission, advice: null, reason: "initial" });
    const knownCaps = new Set(
      this.store.list("capability").map((c) => String(c.capability_id)),
    );
    const tasks = validatePlanProposal(proposal, knownCaps);
    // Incident R1 — the previewed task list is digested/pinned below, so
    // it must already be data-flow sound (consumed artifacts need their
    // producer edge). The serve canonicalize seam repairs before this;
    // an unsound proposal fails closed here rather than entering a
    // digestible preview.
    assertPlanDataflow(tasks as unknown as Array<Record<string, unknown>>);
    const eid = effectiveInputDigest({
      project_id: input.project_id,
      goal: input.goal,
      granted_permissions: input.granted_permissions,
      authorized_workspaces: workspaces,
      risk_ceiling: risk,
      operator_id: input.operator_id,
      allowed_capabilities: plannerEvidence?.allowed_capabilities,
      capability_sets: plannerEvidence?.capability_sets,
    });
    const pd = planDigest({
      project_id: input.project_id,
      effective_input_digest: eid,
      tasks,
      granted_permissions: input.granted_permissions,
      authorized_workspaces: workspaces,
      risk_ceiling: risk,
    });
    const row = persistPlanPreview(this.store, {
      missionInput: {
        project_id: input.project_id,
        goal: input.goal,
        metadata: input.metadata ?? {},
        granted_permissions: input.granted_permissions ?? [],
        authorized_workspaces: workspaces,
        risk_ceiling: risk,
        operator_id: input.operator_id ?? null,
      },
      effective_input_digest: eid,
      plan_digest: pd,
      canonical_tasks: tasks as unknown as Array<Record<string, unknown>>,
      attempts: plannerEvidence?.attempts ?? [],
      winner: plannerEvidence?.winner ?? null,
      planner_run_id: plannerEvidence?.planner_run_id,
      operator_id: input.operator_id,
      ttlSeconds: this.deps.planPreviewTtlSeconds,
    });
    return {
      preview_id: row.preview_id,
      plan_digest: row.plan_digest,
      effective_input_digest: row.effective_input_digest,
      plan: { tasks: row.canonical_tasks },
      planner: row.planner ?? null,
      planner_attempt_id: row.planner_attempt_id ?? null,
      planner_run_id: row.planner_run_id ?? null,
      expires_at: row.expires_at,
      state: row.state,
      plan_source: plannerEvidence?.winner ? "LLM" : "TEMPLATE",
      plan_model: plannerEvidence?.winner?.model ?? null,
      warnings: plannerEvidence?.warnings ?? [],
    };
  }

  /**
   * §14–§16, §28 — confirm a persisted preview. Loads the canonical row,
   * verifies digest/expiry/authority, then in ONE store transaction creates
   * the mission carrying `pinned_plan_tasks` = preview.canonical_tasks and
   * consumes the preview (CAS READY→CONSUMED + consumed_mission_id). A retry
   * of an already-consumed preview returns the same mission — ONE preview
   * → AT MOST ONE mission.
   */
  confirmPlanPreview(input: {
    preview_id: string;
    plan_digest: string;
    operator_id?: string;
  }): Record<string, unknown> {
    const result = this.store.immediate(() => {
      const v = verifyPlanPreviewForConfirm(this.store, {
        preview_id: input.preview_id,
        plan_digest: input.plan_digest,
        operator_id: input.operator_id,
      });
      if (v.mode === "ALREADY_CONSUMED") {
        const existing = this.deps.service.getMission(v.mission_id);
        return { mission: existing, already: true };
      }
      const mi = v.preview.mission_input as Record<string, unknown>;
      // §14.6/§19 — rerun canonical plan validation on the PERSISTED tasks
      // before committing them: a digest match is not validity.
      const knownCaps = new Set(
        this.store.list("capability").map((c) => String(c.capability_id)),
      );
      validatePlanProposal(
        { tasks: v.preview.canonical_tasks },
        knownCaps,
      );
      // Incident R1 §6 — confirm only VALIDATES the persisted canonical
      // plan; it never repairs. A READY preview pinned before the
      // data-flow authority (or otherwise unsound) fails closed here —
      // it is not consumed, no mission is created, the operator must
      // request a fresh preview.
      assertPlanDataflow(
        v.preview.canonical_tasks as Array<Record<string, unknown>>,
      );
      // R5 — replay persisted authority VERBATIM. Normalization already ran
      // before the persisted digests at preview creation; confirm may only
      // validate what was pinned, never widen it. A READY preview without
      // valid canonical workspace authority fails closed (regenerate a fresh
      // preview); it is not consumed and nothing is mutated.
      const authorizedWorkspaces = assertPreviewWorkspaceAuthority(mi);
      const miMeta = (mi.metadata as Record<string, unknown> | undefined) ?? {};
      const metadata = {
        ...((mi.metadata as Record<string, unknown> | undefined) ?? {}),
        pinned_plan: {
          preview_id: v.preview.preview_id,
          plan_digest: v.preview.plan_digest,
          planner_attempt_id: v.preview.planner_attempt_id ?? null,
          planner: v.preview.planner ?? null,
        },
        // What the serve-side template planner returns verbatim — the exact
        // persisted canonical tasks, never re-planned.
        pinned_plan_tasks: v.preview.canonical_tasks,
        // plan_source records WHO planned it (LLM/expander/template) — the
        // pinned provenance lives under pinned_plan.
        plan_source: miMeta.plan_source ?? (v.preview.planner ? "LLM" : "PINNED_PREVIEW"),
        plan_model: miMeta.plan_model ?? (v.preview.planner as Record<string, unknown> | null)?.model ?? null,
      };
      const mission = this.createMissionFromPreview({
        project_id: String(mi.project_id),
        goal: String(mi.goal),
        metadata,
        granted_permissions: (mi.granted_permissions as string[] | undefined) ?? [],
        authorized_workspaces: authorizedWorkspaces,
        risk_ceiling: (mi.risk_ceiling as string | undefined) ?? undefined,
        operator_id: input.operator_id,
      });
      consumePlanPreview(this.store, v.preview, String(mission.mission_id));
      return { mission, already: false };
    });
    if (!result.already) {
      this.deps.runtime.runtimeEntity(String(result.mission.mission_id));
      this.deps.supervisor.wake(String(result.mission.mission_id), "MISSION_CREATED");
    }
    return result.mission;
  }

  /**
   * The mission-create half of startMissionInternal, callable inside an
   * outer store.immediate() so preview-consume and mission-create commit
   * atomically. Same P12/P13 pinning as the public path — bound missions
   * keep using startBoundMission (they never carry a UI preview).
   */
  private createMissionFromPreview(input: {
    project_id: string;
    goal: string;
    metadata?: Record<string, unknown>;
    granted_permissions?: string[];
    authorized_workspaces?: string[];
    risk_ceiling?: string;
    operator_id?: string;
  }): Record<string, unknown> {
    if ((input as { mission_id?: unknown }).mission_id != null) {
      throw new IntegrityError(
        "FAIL_CLOSED_MISSION_ID_PUBLIC",
        "mission_id pinning is internal-only",
      );
    }
    const metadata = { ...(input.metadata ?? {}) } as Record<string, unknown>;
    // R3 §3 — pin the canonical mission origin for delivery-destination
    // binding: the authenticated operator identity (x-operator-id), never
    // caller-supplied metadata. A telegram:<chatId> origin binds explicit
    // delivery back to exactly that chat.
    metadata.mission_origin = {
      operator_id: input.operator_id ?? null,
      provenance: "MISSION_INGRESS",
      pinned_at: utcnow(),
    };
    const boundAgentId = metadata.org_agent_id ? String(metadata.org_agent_id) : null;
    if (boundAgentId) {
      try {
        metadata.agent_contract = this.deps.service.agentContracts.pin(boundAgentId, {
          businessId: metadata.business_id ? String(metadata.business_id) : null,
          projectId: input.project_id,
          actor: `operator:${input.operator_id ?? "system"}`,
        });
      } catch (e) {
        if (e instanceof PolicyError || e instanceof IntegrityError) {
          this.deps.service.agentContracts.auditDenial(
            (e as { code?: string }).code ?? "FAIL_CLOSED_AGENT_POLICY",
            (e as Error).message,
            { agentId: boundAgentId },
          );
        }
        throw e;
      }
    }
    let canonicalBizId: string | null = null;
    if (boundAgentId) {
      const agent = this.deps.service.store.tryGet("org_agent", boundAgentId) as
        | Record<string, unknown>
        | null;
      if (!agent) {
        throw new IntegrityError("FAIL_CLOSED_BUSINESS_CONTEXT_MISMATCH", `agent:${boundAgentId} unknown`);
      }
      canonicalBizId = String(agent.business_id);
      const canonicalDept = agent.department == null ? null : String(agent.department);
      if (metadata.business_id != null && String(metadata.business_id) !== canonicalBizId) {
        throw new IntegrityError("FAIL_CLOSED_BUSINESS_CONTEXT_MISMATCH", `business_id:${String(metadata.business_id)}!=${canonicalBizId}`);
      }
      if (metadata.department != null && canonicalDept != null && String(metadata.department) !== canonicalDept) {
        throw new IntegrityError("FAIL_CLOSED_BUSINESS_CONTEXT_MISMATCH", `department:${String(metadata.department)}!=${canonicalDept}`);
      }
      metadata.business_id = canonicalBizId;
      if (canonicalDept != null) metadata.department = canonicalDept;
    }
    if (metadata.business_id) {
      const bizId = String(metadata.business_id);
      const biz = this.deps.service.store.tryGet("business", bizId) as
        | Record<string, unknown>
        | null;
      if (!biz) {
        throw new IntegrityError("FAIL_CLOSED_SECRET_BUSINESS_UNKNOWN", bizId);
      }
      if (String(biz.project_id) !== String(input.project_id)) {
        throw new IntegrityError("FAIL_CLOSED_SECRET_CROSS_BUSINESS", `${bizId}:${String(input.project_id)}`);
      }
      if (boundAgentId && canonicalBizId !== bizId) {
        throw new IntegrityError("FAIL_CLOSED_SECRET_AGENT_REF", boundAgentId);
      }
    }
    metadata.business_context = {
      business_id: metadata.business_id != null ? String(metadata.business_id) : null,
      org_agent_id: boundAgentId,
      department: metadata.department != null ? String(metadata.department) : null,
      project_id: String(input.project_id),
      provenance: boundAgentId ? "org_agent" : "caller",
      pinned_at: utcnow(),
    };
    metadata.secret_grants = this.deps.service.secretPolicies.pinForMission({
      businessId: metadata.business_id ? String(metadata.business_id) : null,
    });
    return this.deps.service.createMission({
      project_id: input.project_id,
      goal: input.goal,
      metadata,
      granted_permissions: input.granted_permissions ?? [],
      authorized_workspaces: input.authorized_workspaces,
      risk_ceiling: input.risk_ceiling,
    });
  }

  /** Safe read model for a persisted preview + its planner attempts. */
  planPreview(previewId: string): Record<string, unknown> {
    const row = this.store.tryGet(PREVIEW_ENTITY, String(previewId));
    if (!row) throw new NotFoundError(`mission_plan_preview:${previewId}`);
    const attempts = this.store
      .list(ATTEMPT_ENTITY)
      .filter((a) => String(a.preview_id) === String(previewId))
      .sort((a, b) => Number(a.attempt_no) - Number(b.attempt_no));
    const plannerRun = row.planner_run_id
      ? this.store.tryGet(RUN_ENTITY, String(row.planner_run_id))
      : null;
    return { preview: row, planner_attempts: attempts, planner_run: plannerRun };
  }

  /** Create + queue a mission for orchestration. */
  startMission(input: {
    project_id: string;
    goal: string;
    metadata?: Record<string, unknown>;
    granted_permissions?: string[];
    authorized_workspaces?: string[];
    risk_ceiling?: string;
    operator_id?: string;
    /** §4.3 two-step submit: the plan digest returned by previewMission. */
    confirm_plan?: { digest: string };
  }): Record<string, unknown> {
    // Foundation V2 §1/§8: the generic Mission Control API must never
    // accept a caller-pinned mission identity — bound identity is minted
    // only by the internal startBoundMission seam. Reject fail-closed so
    // a smuggled field can never reserve or occupy a work-bound id.
    if ((input as { mission_id?: unknown }).mission_id != null) {
      throw new IntegrityError(
        "FAIL_CLOSED_MISSION_ID_PUBLIC",
        "mission_id pinning is internal-only — public mission creation mints its own id",
      );
    }
    return this.startMissionInternal(input, undefined);
  }

  /*
   * INTERNAL bound-mission seam — BusinessLayer only. Identical pipeline
   * to startMission except the mission identity is DERIVED from the
   * canonical `work_open_binding` (`binding_open_id`) — never from an
   * arbitrary caller-supplied pin. The seam loads the binding itself,
   * validates the full canonical chain (INTENT state, work item,
   * business, project, org-agent scope), and stamps the non-forgeable
   * internal origin proof `bound_open_id` on the mission it creates.
   * Not reachable through /api/missions or any generic caller path.
   */
  startBoundMission(input: {
    binding_open_id: string;
    project_id: string;
    goal: string;
    metadata?: Record<string, unknown>;
    granted_permissions?: string[];
    authorized_workspaces?: string[];
    risk_ceiling?: string;
    operator_id?: string;
    confirm_plan?: { digest: string };
  }): Record<string, unknown> {
    const openId = String(input.binding_open_id);
    // Step 1 — the binding itself must be canonically valid (identity,
    // state, work item, business, project, scope). PROVENANCE mode here:
    // this check only proves the binding — the agent-ACTIVE requirement
    // is enforced separately below, and ONLY for new-mission creation.
    const { binding, ok: bound, reason } = validateWorkOpenBindingById(
      this.deps.service.store,
      openId,
      {
        requireState: "INTENT",
        expectedProjectId: String(input.project_id),
        mode: "PROVENANCE",
      },
    );
    if (!bound || !binding) {
      throw new IntegrityError(
        "FAIL_CLOSED_BINDING_INVALID",
        `${openId}: ${reason ?? "canonical binding invalid"}`,
      );
    }
    const reservedId = String(binding.mission_id);
    const existing = this.deps.service.store.tryGet("mission", reservedId) as
      | StoreRow
      | null;
    if (existing) {
      // R2 §3 + R3 §6: crash-retry adoption requires the FULL canonical
      // validation — origin proof alone is not sufficient — but in
      // PROVENANCE mode: the mission already exists, so only its origin
      // is being proven; a later-PAUSED/TERMINATED agent must not veto
      // history. Any mismatch → no adoption, no BOUND.
      const check = validateWorkOpenBindingById(this.deps.service.store, openId, {
        requireState: "INTENT",
        expectedProjectId: String(input.project_id),
        forMission: existing,
        mode: "PROVENANCE",
      });
      if (!check.ok) {
        throw new IntegrityError(
          "FAIL_CLOSED_MISSION_ORIGIN_CONFLICT",
          `${reservedId} fails canonical binding validation: ${check.reason}`,
        );
      }
      return existing;
    }
    // Step 2 — a NEW mission is about to be created: ADMISSION mode now
    // requires the bound agent to be currently ACTIVE (R3 §2). A paused
    // or terminated agent fails closed here — no mission is minted.
    const admission = validateWorkOpenBindingById(this.deps.service.store, openId, {
      requireState: "INTENT",
      expectedProjectId: String(input.project_id),
      mode: "ADMISSION",
    });
    if (!admission.ok) {
      throw new IntegrityError(
        "FAIL_CLOSED_BINDING_INVALID",
        `${openId}: ${admission.reason ?? "canonical binding invalid"}`,
      );
    }
    // R2 §1: canonical context is DERIVED from the binding + its
    // canonical records — caller metadata may mirror it but never
    // defines it. Omitted authoritative fields are filled; conflicting
    // ones fail closed.
    const workItem = this.deps.service.store.get(
      "work_item",
      String(binding.work_item_id),
    ) as Record<string, unknown>;
    const canonicalFields: Array<[string, unknown]> = [
      ["business_id", binding.business_id],
      ["work_item_id", binding.work_item_id],
      ["work_item_open_id", openId],
      ["org_agent_id", binding.org_agent_id ?? null],
      ["department", workItem.department ?? null],
      ["source", "business_layer"],
    ];
    const metadata = { ...(input.metadata ?? {}) } as Record<string, unknown>;
    for (const [key, canonical] of canonicalFields) {
      const supplied = metadata[key];
      if (
        supplied != null &&
        canonical != null &&
        String(supplied) !== String(canonical)
      ) {
        throw new IntegrityError(
          "FAIL_CLOSED_BINDING_CONTEXT_MISMATCH",
          `metadata.${key} conflicts with canonical binding context`,
        );
      }
      metadata[key] = canonical;
    }
    return this.startMissionInternal({ ...input, metadata }, binding);
  }

  private startMissionInternal(
    input: {
      project_id: string;
      goal: string;
      metadata?: Record<string, unknown>;
      granted_permissions?: string[];
      authorized_workspaces?: string[];
      risk_ceiling?: string;
      operator_id?: string;
      confirm_plan?: { digest: string };
    },
    binding: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (input.confirm_plan?.digest) {
      const preview = this.previewMission(input);
      if (preview.plan_digest !== input.confirm_plan.digest) {
        throw new PolicyError("FAIL_CLOSED_PLAN_DIGEST_MISMATCH", String(input.confirm_plan.digest).slice(0, 16));
      }
    }
    const metadata = { ...(input.metadata ?? {}) } as Record<string, unknown>;
    // R3 §3 — pin the canonical mission origin for delivery-destination
    // binding: the authenticated operator identity (x-operator-id), never
    // caller-supplied metadata. A telegram:<chatId> origin binds explicit
    // delivery back to exactly that chat.
    metadata.mission_origin = {
      operator_id: input.operator_id ?? null,
      provenance: "MISSION_INGRESS",
      pinned_at: utcnow(),
    };
    const boundAgentId = metadata.org_agent_id ? String(metadata.org_agent_id) : null;
    if (boundAgentId) {
      // P12: a mission bound to an org_agent pins its agent execution
      // contract (id/version/digest/policy snapshot) into immutable mission
      // metadata. assertExecutable fails closed on inactive agent,
      // disabled contract, business mismatch, or out-of-scope project.
      try {
        metadata.agent_contract = this.deps.service.agentContracts.pin(boundAgentId, {
          businessId: metadata.business_id ? String(metadata.business_id) : null,
          projectId: input.project_id,
          actor: `operator:${input.operator_id ?? "system"}`,
        });
      } catch (e) {
        // R1 §6: pin-time contract failures are audited as denials before
        // they propagate — inactive agent, disabled contract, business
        // mismatch, project denial, integrity/provenance all land here.
        if (e instanceof PolicyError || e instanceof IntegrityError) {
          this.deps.service.agentContracts.auditDenial(
            (e as { code?: string }).code ?? "FAIL_CLOSED_AGENT_POLICY",
            (e as Error).message,
            { agentId: boundAgentId },
          );
        }
        throw e;
      }
    }
    // P13-R3 §1: canonical business context. When the mission is bound to
    // an org_agent, that agent row is the ONLY authority for
    // business/department scope — caller-supplied business_id/department
    // must match it exactly (mismatch fails closed), and a missing
    // business_id inherits the agent's business so a bound mission can
    // never escape its monetary/secret scope. The resolved context is
    // pinned immutably; downstream governance consumes the pin, not
    // arbitrary caller metadata.
    let canonicalBizId: string | null = null;
    if (boundAgentId) {
      const agent = this.deps.service.store.tryGet("org_agent", boundAgentId) as
        | Record<string, unknown>
        | null;
      if (!agent) {
        throw new IntegrityError("FAIL_CLOSED_BUSINESS_CONTEXT_MISMATCH", `agent:${boundAgentId} unknown`);
      }
      canonicalBizId = String(agent.business_id);
      const canonicalDept = agent.department == null ? null : String(agent.department);
      if (metadata.business_id != null && String(metadata.business_id) !== canonicalBizId) {
        throw new IntegrityError(
          "FAIL_CLOSED_BUSINESS_CONTEXT_MISMATCH",
          `business_id:${String(metadata.business_id)}!=${canonicalBizId}`,
        );
      }
      if (
        metadata.department != null &&
        canonicalDept != null &&
        String(metadata.department) !== canonicalDept
      ) {
        throw new IntegrityError(
          "FAIL_CLOSED_BUSINESS_CONTEXT_MISMATCH",
          `department:${String(metadata.department)}!=${canonicalDept}`,
        );
      }
      metadata.business_id = canonicalBizId;
      if (canonicalDept != null) metadata.department = canonicalDept;
    }
    // P13: pin the mission's credential grant set — a snapshot of every
    // ACTIVE secret_policy of its business (refs + allow-sets + policy
    // provenance, never values). Later expansion never retro-broadens;
    // revocation narrows via the live-policy check at fetch time.
    // R1 §5: business_id must resolve to a REAL business whose canonical
    // project matches the mission's project — a caller cannot mint
    // another business's grants by forging metadata.business_id.
    if (metadata.business_id) {
      const bizId = String(metadata.business_id);
      const biz = this.deps.service.store.tryGet("business", bizId) as
        | Record<string, unknown>
        | null;
      if (!biz) {
        throw new IntegrityError("FAIL_CLOSED_SECRET_BUSINESS_UNKNOWN", bizId);
      }
      if (String(biz.project_id) !== String(input.project_id)) {
        throw new IntegrityError("FAIL_CLOSED_SECRET_CROSS_BUSINESS", `${bizId}:${String(input.project_id)}`);
      }
      if (boundAgentId && canonicalBizId !== bizId) {
        throw new IntegrityError("FAIL_CLOSED_SECRET_AGENT_REF", boundAgentId);
      }
    }
    metadata.business_context = {
      business_id: metadata.business_id != null ? String(metadata.business_id) : null,
      org_agent_id: boundAgentId,
      department: metadata.department != null ? String(metadata.department) : null,
      project_id: String(input.project_id),
      provenance: boundAgentId ? "org_agent" : "caller",
      pinned_at: utcnow(),
    };
    metadata.secret_grants = this.deps.service.secretPolicies.pinForMission({
      businessId: metadata.business_id ? String(metadata.business_id) : null,
    });
    const workspaces = this.normalizeMissionWorkspaces(input);
    const mission = binding
      ? this.deps.service.createBoundMission(binding, {
          project_id: input.project_id,
          goal: input.goal,
          metadata,
          granted_permissions: input.granted_permissions ?? [],
          authorized_workspaces: workspaces,
          risk_ceiling: canonicalRiskCeiling(input.risk_ceiling),
        })
      : this.deps.service.createMission({
          project_id: input.project_id,
          goal: input.goal,
          metadata,
          granted_permissions: input.granted_permissions ?? [],
          authorized_workspaces: workspaces,
          risk_ceiling: canonicalRiskCeiling(input.risk_ceiling),
        });
    this.deps.runtime.runtimeEntity(String(mission.mission_id));
    this.deps.supervisor.wake(String(mission.mission_id), "MISSION_CREATED");
    return mission;
  }

  pauseMission(missionId: string, operatorId?: string) {
    const op = requireOperator(operatorId);
    const rt = this.deps.runtime.pause(missionId, op);
    this.deps.supervisor.wake(missionId, "MISSION_RESUME", { detail: "pause" });
    return rt;
  }

  resumeMission(missionId: string, operatorId?: string) {
    const op = requireOperator(operatorId);
    const rt = this.deps.runtime.resume(missionId, op);
    this.deps.supervisor.wake(missionId, "MISSION_RESUME", { operator: op });
    return rt;
  }

  cancelMission(missionId: string, operatorId?: string) {
    const op = requireOperator(operatorId);
    return this.deps.runtime.cancel(missionId, op);
  }

  approve(approvalId: string, operatorId: string | undefined, scope?: Record<string, unknown>, reason?: string) {
    const op = requireOperator(operatorId);
    const decision = this.deps.approvals.decide(approvalId, op, "APPROVED", scope, reason);
    const a = this.deps.approvals.get(approvalId);
    if (a.mission_id) {
      this.deps.supervisor.wake(String(a.mission_id), "APPROVAL_GRANTED", {
        approval_id: approvalId,
      });
    }
    return decision;
  }

  deny(approvalId: string, operatorId: string | undefined, scope?: Record<string, unknown>, reason?: string) {
    const op = requireOperator(operatorId);
    return this.deps.approvals.decide(approvalId, op, "DENIED", scope, reason);
  }

  /**
   * P13 broker-fetch authority: ordered fail-closed checks for a
   * credential release. Missions, tasks and their binding are canonical
   * facts; the secret_policy + mission pin + current policy intersect
   * decides, and every denial is audited with its reason.
   */
  authorizeCredentialFetch(
    missionId: string,
    taskId: string,
    credentialRef: string,
  ): { granted: boolean; reason: string } {
    const mission = this.deps.service.store.tryGet("mission", missionId);
    if (!mission) {
      this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_MISSION_NOT_FOUND");
      return { granted: false, reason: "FAIL_CLOSED_MISSION_NOT_FOUND" };
    }
    const task = this.deps.service.store.tryGet("task", taskId);
    if (!task) {
      this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_TASK_NOT_FOUND");
      return { granted: false, reason: "FAIL_CLOSED_TASK_NOT_FOUND" };
    }
    if (String(task.mission_id) !== missionId) {
      this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_TASK_NOT_IN_MISSION");
      return { granted: false, reason: "FAIL_CLOSED_TASK_NOT_IN_MISSION" };
    }
    // R1 §3: release is bound to the EXACT canonical task/executor context
    // — the broker request carries only ids; it can never invent routing
    // identity. An unrouted/unbound task cannot receive a secret.
    const executorId = task.selected_executor ? String(task.selected_executor) : null;
    const boundStates = new Set(["ROUTED", "RUNNING"]);
    if (!executorId || !boundStates.has(String(task.status))) {
      this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_SECRET_EXECUTOR_UNBOUND");
      return { granted: false, reason: "FAIL_CLOSED_SECRET_EXECUTOR_UNBOUND" };
    }
    const decision = this.deps.service.secretPolicies.authorizeRelease({
      mission,
      task,
      credentialRef,
      executorId,
    });
    if (!decision.granted) {
      this.auditSecretDeny(missionId, taskId, credentialRef, decision.reason);
      return { granted: false, reason: decision.reason };
    }
    this.deps.service.store.appendEvidence(missionId, "CREDENTIAL_RELEASE_GRANTED", {
      credential_name: credentialRef,
      task_id: taskId,
      policy_id: decision.policy?.policy_id,
      policy_version: decision.policy?.policy_version,
      executor_id: executorId,
    });
    return { granted: true, reason: "GRANTED" };
  }

  /**
   * R3 §2: /api/broker/fetch entry — the worker credential is a
   * task-scoped HMAC capability, not the master token. Verify the
   * signature server-side, then bind the claims to canonical facts:
   * body identity, the task's selected executor, and — when a governed
   * task exists — its exact governed_task_id. Only then does the normal
   * P13 policy chain (authorizeCredentialFetch) run; a capability never
   * expands policy or P12 authority.
   */
  authorizeBrokerFetch(
    missionId: string,
    taskId: string,
    credentialRef: string,
    capability: string,
    masterSecret: string,
  ): { granted: boolean; reason: string } {
    // R4 §1: the master secret is registered at the verification boundary
    // too, so an echo from a hostile worker is redacted even when minting
    // happened on a different path.
    registerSensitiveMaterial(masterSecret);
    const claims = verifyBrokerCapability(masterSecret, capability);
    if (!claims) {
      this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_BROKER_CAPABILITY");
      return { granted: false, reason: "FAIL_CLOSED_BROKER_CAPABILITY" };
    }
    if (claims.mission_id !== missionId || claims.task_id !== taskId) {
      this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH");
      return { granted: false, reason: "FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH" };
    }
    const task = this.deps.service.store.tryGet("task", taskId);
    if (task) {
      const boundExecutor = task.selected_executor ? String(task.selected_executor) : null;
      if (boundExecutor && claims.executor_id !== boundExecutor) {
        this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_BROKER_CAPABILITY_EXECUTOR");
        return { granted: false, reason: "FAIL_CLOSED_BROKER_CAPABILITY_EXECUTOR" };
      }
      const governed = this.deps.service.store
        .list("governed_task")
        .filter((g) => String(g.task_id) === taskId);
      if (governed.length > 0) {
        const match = governed.some((g) => String(g.governed_task_id) === claims.governed_task_id);
        if (!match) {
          this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH");
          return { granted: false, reason: "FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH" };
        }
      } else if (claims.governed_task_id != null) {
        // The claim names a governed task that does not exist canonically.
        this.auditSecretDeny(missionId, taskId, credentialRef, "FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH");
        return { granted: false, reason: "FAIL_CLOSED_BROKER_CAPABILITY_MISMATCH" };
      }
    }
    return this.authorizeCredentialFetch(missionId, taskId, credentialRef);
  }

  private auditSecretDeny(
    missionId: string,
    taskId: string,
    credentialRef: string,
    reason: string,
  ): void {
    try {
      this.deps.service.store.appendEvidence(missionId, "CREDENTIAL_RELEASE_DENIED", {
        credential_name: credentialRef,
        task_id: taskId,
        reason,
      });
    } catch {
      // mission may not exist — audit on the task axis instead
      this.deps.service.store.event({
        entity_type: "task",
        entity_id: taskId,
        event_type: "CREDENTIAL_RELEASE_DENIED",
        actor: "PAIR_SECRET_GOVERNANCE",
        metadata: { credential_name: credentialRef, reason },
      });
    }
  }

  /* ---------------- mission schedules ------------------------------------ */

  schedules(): Array<Record<string, unknown>> {
    return this.deps.schedules?.list() ?? [];
  }

  createSchedule(input: {
    goal: string;
    cron: string;
    project_id?: string;
    name?: string;
    metadata?: Record<string, unknown>;
    operator_id?: string;
  }): Record<string, unknown> {
    if (!this.deps.schedules) throw new PolicyError("FAIL_CLOSED_NO_SCHEDULER", "mission_control.schedules");
    const op = requireOperator(input.operator_id);
    return this.deps.schedules.create({ ...input, operator_id: op });
  }

  setScheduleEnabled(id: string, enabled: boolean, operatorId?: string) {
    if (!this.deps.schedules) throw new PolicyError("FAIL_CLOSED_NO_SCHEDULER", "mission_control.schedules");
    const op = requireOperator(operatorId);
    return this.deps.schedules.setEnabled(id, enabled, op);
  }

  deleteSchedule(id: string, operatorId?: string) {
    if (!this.deps.schedules) throw new PolicyError("FAIL_CLOSED_NO_SCHEDULER", "mission_control.schedules");
    const op = requireOperator(operatorId);
    return this.deps.schedules.remove(id, op);
  }

  /**
   * Fire every due schedule through the canonical startMission path. When an
   * expander is supplied (the serve script's LLM planner seam) each due goal
   * is expanded into a real plan first — scheduled missions get the same plan
   * quality as the UI's Plan & run instead of the minimal template fallback.
   */
  async tickSchedules(
    now?: string,
    expander?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): Promise<{ fired: string[]; errors: string[] }> {
    if (!this.deps.schedules) return { fired: [], errors: [] };
    const defaultProject = String(this.store.list("project")[0]?.project_id ?? "");
    return this.deps.schedules.fireDue(
      async (input) => {
        const expanded = expander ? await expander(input as Record<string, unknown>) : { input };
        const exInput = (expanded as { input?: unknown }).input ?? expanded;
        const plannerEvidence = (expanded as { planner?: never }).planner;
        const preview = this.createPlanPreview({
          project_id: String((exInput as Record<string, unknown>).project_id ?? defaultProject),
          goal: String((exInput as Record<string, unknown>).goal ?? input.goal),
          metadata: (exInput as Record<string, unknown>).metadata as Record<string, unknown> | undefined,
        }, plannerEvidence);
        return this.confirmPlanPreview({
          preview_id: String(preview.preview_id),
          plan_digest: String(preview.plan_digest),
        });
      },
      now,
    );
  }

  /** Cost-guard read model — remote dispatch usage vs the daily cap. */
  cost(): Record<string, unknown> {
    const today = utcnow().slice(0, 10);
    const todayRemote = this.store
      .list("executor_execution")
      .filter(
        (e) =>
          String(e.executor_id ?? "") === "DEVIN" &&
          String(e.created_at ?? "").startsWith(today),
      );
    const limit = Number(process.env.PAIR_MAX_REMOTE_TASKS_PER_DAY ?? 10);
    return {
      remote_dispatches_today: todayRemote.length,
      remote_daily_limit: limit,
      cost_halt:
        process.env.PAIR_COST_HALT === "1" ||
        (this.deps.costHaltFile ? fs.existsSync(this.deps.costHaltFile) : false),
      schedules_active: this.deps.schedules?.list().filter((s) => s.enabled && !s.deleted).length ?? 0,
      // P13 read model: monetary policies, usage by scope, live
      // reservations, billing-mode breakdown, unpriced dispatches.
      monetary: this.deps.service.cost.position(),
    };
  }

  /* ---------------- P13 cost + secret governance -------------------------- */

  costPolicies(): Array<Record<string, unknown>> {
    return this.deps.service.cost.listCostPolicies();
  }

  costProfiles(): Array<Record<string, unknown>> {
    return this.deps.service.cost.listCostProfiles();
  }

  secretPolicies(): Array<Record<string, unknown>> {
    return this.deps.service.secretPolicies.listPolicies();
  }

  /** R3 §3: create-only — colliding identity fails closed, never a
   *  silent authority rewrite. */
  createCostPolicy(body: Record<string, unknown>, actor: string) {
    return this.deps.service.cost.createCostPolicy(body, actor);
  }

  createCostProfile(body: Record<string, unknown>, actor: string) {
    return this.deps.service.cost.createCostProfile(body, actor);
  }

  upsertCostPolicy(body: Record<string, unknown>, actor: string, expectedVersion?: number) {
    return this.deps.service.cost.upsertCostPolicy(body, actor, expectedVersion);
  }

  updateCostPolicy(body: Record<string, unknown>, actor: string, expectedVersion: number) {
    return this.deps.service.cost.updateCostPolicy(body, actor, expectedVersion);
  }

  upsertCostProfile(body: Record<string, unknown>, actor: string, expectedVersion?: number) {
    return this.deps.service.cost.upsertCostProfile(body, actor, expectedVersion);
  }

  updateCostProfile(body: Record<string, unknown>, actor: string, expectedVersion: number) {
    return this.deps.service.cost.updateCostProfile(body, actor, expectedVersion);
  }

  createSecretPolicy(body: Record<string, unknown>, actor: string) {
    return this.deps.service.secretPolicies.createPolicy(body, actor);
  }

  updateSecretPolicy(policyId: string, body: Record<string, unknown>, expectedVersion: number, actor: string) {
    return this.deps.service.secretPolicies.updatePolicy(policyId, body, expectedVersion, actor);
  }

  revokeSecretPolicy(policyId: string, actor: string) {
    return this.deps.service.secretPolicies.setPolicyStatus(policyId, "REVOKED", actor);
  }

  requestReconciliation(missionId: string, operatorId?: string, executionId?: string) {
    const op = requireOperator(operatorId);
    const receipt = this.deps.reconciliation.reconcile({
      mission_id: missionId,
      execution_id: executionId,
      correlation_id: `operator:${op}`,
    });
    this.deps.supervisor.wake(missionId, "RECONCILIATION_RESULT", {
      operator: op,
      outcome: receipt.outcome,
    });
    return receipt;
  }

  acknowledgeTerminal(missionId: string, operatorId?: string) {
    const op = requireOperator(operatorId);
    const rt = this.store.tryGet("mission_runtime", `MRT_${missionId}`);
    if (!rt) throw new PolicyError("FAIL_CLOSED_MISSION_RUNTIME_NOT_FOUND", missionId);
    this.store.event({
      entity_type: "mission_runtime",
      entity_id: `MRT_${missionId}`,
      event_type: "TERMINAL_ACKNOWLEDGED",
      actor: `OPERATOR:${op}`,
      metadata: { mission_id: missionId },
    });
    return rt;
  }

  /** Wake a mission for a scheduler-visible reason. */
  wake(missionId: string, reason: WakeReason, detail: Record<string, unknown> = {}) {
    return this.deps.supervisor.wake(missionId, reason, detail);
  }

  /** Tick all live missions once. */
  tick(now?: string) {
    return this.deps.supervisor.tick(now);
  }

  /* ---------------- promotion actions -------------------------------------- */

  approvePromotion(promotionId: string, operatorId: string | undefined) {
    const op = requireOperator(operatorId);
    if (!this.deps.selfmod) {
      throw new PolicyError("FAIL_CLOSED_SELFMOD_NOT_CONFIGURED", promotionId);
    }
    return this.deps.selfmod.approvePromotion(promotionId, op);
  }

  rejectPromotion(promotionId: string, operatorId: string | undefined, reason: string) {
    const op = requireOperator(operatorId);
    if (!this.deps.selfmod) {
      throw new PolicyError("FAIL_CLOSED_SELFMOD_NOT_CONFIGURED", promotionId);
    }
    return this.deps.selfmod.rejectPromotion(promotionId, reason);
  }
}
