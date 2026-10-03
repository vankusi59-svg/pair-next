/**
 * F2 — Cross-executor canonical artifact handoff.
 *
 * A downstream governed execution may only consume a producer's
 * canonical F1 bytes when ALL of the following hold (§3):
 *
 *   1. the artifact was canonically accepted (F1 acceptance history);
 *   2. the producer execution reached canonical terminal validation PASS;
 *   3. the artifact_id is part of THAT PASS result's artifact_ids;
 *   4. ArtifactAuthority re-verifies the artifact at handoff time;
 *   5. producer and consumer belong to the same mission;
 *   6. the producer task is an actual dependency predecessor in the
 *      CURRENT committed plan revision;
 *   7. the artifact is part of the declared dataflow between those
 *      tasks (the existing produces/consumes name model — no second
 *      planner contract);
 *   8. the consumer pins exact dependency_artifacts BEFORE dispatch
 *      (persisted on the governed task, digest-covered);
 *   9. the consumer never trusts a producer-side path;
 *  10. identity is never recomputed from a copied file;
 *  11. materialization preserves the exact artifact identity bytes;
 *  12. provable pre-dispatch failures produce ZERO executor spend;
 *  13. an earlier execution's artifacts never re-baseline the consumer.
 *
 * Seams:
 *   - ArtifactDependencyResolver: consumer task → declared dataflow name
 *     → unique producer predecessor → validated producer execution →
 *     canonical ART id → pinned contract entry.
 *   - ArtifactHandoffService: durable `artifact_handoff` entity
 *     (PINNED → MATERIALIZED | FETCHED) + the ONE governed local
 *     materialization seam + remote consume authorization for
 *     /api/artifacts/fetch.
 */
import fs from "node:fs";
import path from "node:path";
import {
  canonicalJson,
  digest,
  pathWithin,
  secureReadContained,
  sha256Hex,
  utcnow,
} from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import {
  normalizeArtifactName,
  MAX_ARTIFACT_BYTES,
  type ArtifactAuthority,
} from "./artifact-authority.js";
import type { PairEvidenceStore } from "./store.js";
import type { PairControlPlane } from "./service.js";
import type { ArtifactConsumeCapabilityClaims } from "./artifact-consume-capability.js";
import { artifactDependencySetDigest } from "./artifact-consume-capability.js";
import {
  DELIVERY_CAPABILITY,
  REMOTE_CAPABILITY_SET,
} from "./plan-dataflow.js";

export const DEPENDENCY_ARTIFACT_CONTRACT = "pair-artifact-dependency.v1";
export const HANDOFF_CONTRACT = "pair-artifact-handoff.v1";
export const HANDOFF_ENTITY = "artifact_handoff";
/** Deterministic materialization root INSIDE the governed consumer
 *  workspace — the only place dependency bytes may land. */
export const DEPENDENCY_ARTIFACT_ROOT = ".pair/dependency-artifacts";

/** F2 §35 — bounds. Per-task dependency count, per-artifact size (the F1
 *  bound) and a documented aggregate cap. */
export const MAX_DEPENDENCY_ARTIFACTS_PER_TASK = 32;
export const MAX_DEPENDENCY_ARTIFACT_TOTAL_BYTES = 256 * 1024 * 1024;

/** Dependency-resolution failures classify deterministically as
 *  DEPENDENCY_FAILURE (the recovery classifier maps the FAIL_CLOSED_
 *  DEPENDENCY_* code family) — zero dispatch, zero executor spend. */
export class DependencyResolutionError extends IntegrityError {
  constructor(
    code: string,
    detail: string,
  ) {
    super(code, detail);
    this.name = "DependencyResolutionError";
  }
}

export interface DependencyArtifactEntry {
  artifact_id: string;
  producer_task_id: string;
  producer_governed_task_id: string;
  producer_execution_id: string;
  producer_executor_id: string;
  logical_name: string;
  sha256: string;
  byte_size: number;
  consumer_relative_path: string;
  contract: typeof DEPENDENCY_ARTIFACT_CONTRACT;
}

/** The only destination shape a dependency artifact may be given —
 *  deterministic and derived from the pinned artifact identity, never
 *  from producer or planner text. */
export function dependencyConsumerPath(
  artifactId: string,
  logicalName: string,
): string {
  return `${DEPENDENCY_ARTIFACT_ROOT}/${artifactId}/${logicalName}`;
}

export function canonicalHandoffId(
  consumerGovernedTaskId: string,
  artifactId: string,
  consumerRelativePath: string,
): string {
  return `HOFF_${digest(
    `${consumerGovernedTaskId}|${artifactId}|${consumerRelativePath}`,
  ).slice(0, 40)}`;
}

/** Shape validation for a dependency-artifact entry — used at the gate
 *  so a malformed pin can never reach the governed contract. */
export function validateDependencyArtifactEntry(
  raw: unknown,
): DependencyArtifactEntry {
  const fail = (field: string): never => {
    throw new IntegrityError(
      "FAIL_CLOSED_DEPENDENCY_ARTIFACT_CONTRACT",
      field,
    );
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("entry");
  }
  const e = raw as Record<string, unknown>;
  if (String(e.contract ?? "") !== DEPENDENCY_ARTIFACT_CONTRACT) fail("contract");
  for (const f of [
    "artifact_id",
    "producer_task_id",
    "producer_governed_task_id",
    "producer_execution_id",
    "producer_executor_id",
    "logical_name",
    "consumer_relative_path",
  ] as const) {
    if (typeof e[f] !== "string" || !e[f]) fail(f);
  }
  const sha = e.sha256;
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) fail("sha256");
  const size = e.byte_size;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    fail("byte_size");
  }
  // The pinned destination must stay inside the deterministic handoff
  // root — normalizeArtifactName rejects traversal/absolute/backslashes.
  let rel: string;
  try {
    rel = normalizeArtifactName(e.consumer_relative_path);
  } catch {
    fail("consumer_relative_path");
  }
  if (!rel!.startsWith(`${DEPENDENCY_ARTIFACT_ROOT}/`)) {
    fail("consumer_relative_path_root");
  }
  try {
    normalizeArtifactName(e.logical_name);
  } catch {
    fail("logical_name");
  }
  return {
    artifact_id: String(e.artifact_id),
    producer_task_id: String(e.producer_task_id),
    producer_governed_task_id: String(e.producer_governed_task_id),
    producer_execution_id: String(e.producer_execution_id),
    producer_executor_id: String(e.producer_executor_id),
    logical_name: String(e.logical_name),
    sha256: String(e.sha256),
    byte_size: Number(e.byte_size),
    consumer_relative_path: rel!,
    contract: DEPENDENCY_ARTIFACT_CONTRACT,
  };
}

export function isRemoteCapabilityTask(task: Record<string, unknown>): boolean {
  return ((task.required_capabilities as string[]) ?? []).some((c) =>
    REMOTE_CAPABILITY_SET.has(String(c)),
  );
}

export function isDeliveryCapabilityTask(task: Record<string, unknown>): boolean {
  return ((task.required_capabilities as string[]) ?? []).includes(
    DELIVERY_CAPABILITY,
  );
}

/* ================================================================== */
/* ArtifactDependencyResolver                                          */
/* ================================================================== */

/**
 * Resolves a consumer task's declared dataflow consumes into pinned
 * `dependency_artifacts` contract entries. Returns [] when nothing
 * canonical is consumable for the task — legacy local path dependencies
 * keep their pre-F2 semantics and stay OUT of this mechanism entirely.
 *
 * Fail-closed cases (DependencyResolutionError):
 *   - consume name has zero or several producer predecessors
 *   - the producer is remote-capable but no canonical artifact exists
 *     (a remote file edge can never fall back to a shared filesystem)
 *   - the producer is remote-capable and resolution is ambiguous
 *   - the producer's execution lacks a canonical terminal PASS carrying
 *     the artifact
 *   - the artifact no longer verifies under the F1 authority
 */
export class ArtifactDependencyResolver {
  constructor(private readonly service: PairControlPlane) {}

  private get store(): PairEvidenceStore {
    return this.service.store;
  }

  resolveForConsumer(args: {
    mission: Record<string, unknown>;
    task: Record<string, unknown>;
  }): DependencyArtifactEntry[] {
    const task = args.task;
    // TELEGRAM_DELIVERY keeps its existing governed channel (outbox
    // compat materialization + PAIR_OUTBOX_UPLOAD edges) — the handoff
    // seam must not re-author a delivery path.
    if (isDeliveryCapabilityTask(task)) return [];
    const df = (
      (task.metadata as Record<string, unknown> | undefined)?.pair_dataflow as
        | Record<string, unknown>
        | undefined
    );
    const consumes = Array.isArray(df?.consumes)
      ? (df!.consumes as unknown[]).map((x) => String(x))
      : [];
    if (!consumes.length) return [];
    if (consumes.length > MAX_DEPENDENCY_ARTIFACTS_PER_TASK) {
      throw new DependencyResolutionError(
        "FAIL_CLOSED_DEPENDENCY_RESOLUTION",
        `dependency_count>${MAX_DEPENDENCY_ARTIFACTS_PER_TASK}`,
      );
    }
    const missionId = String(args.mission.mission_id);
    const planId = String(task.plan_id);
    // Tasks carry plan_id (not plan_revision); the committed revision
    // lives on the mission — the gate already binds the dispatched task
    // to the active plan, so same-plan tasks ARE the current revision.
    const planRevision = Number(args.mission.plan_revision ?? 0);
    const depRefs = new Set(
      ((task.depends_on as string[]) ?? []).map((d) => String(d)),
    );
    const planTasks = this.service
      .listTasks(missionId)
      .filter(
        (t) =>
          String(t.plan_id) === planId &&
          String(t.task_id) !== String(task.task_id),
      );
    const producesOf = (t: Record<string, unknown>): Set<string> => {
      const p = (t.metadata as Record<string, unknown> | undefined)
        ?.pair_dataflow as Record<string, unknown> | undefined;
      return new Set(
        Array.isArray(p?.produces) ? (p!.produces as unknown[]).map(String) : [],
      );
    };
    const isDepPredecessor = (t: Record<string, unknown>): boolean =>
      depRefs.has(String(t.task_key)) || depRefs.has(String(t.task_id));

    const entries: DependencyArtifactEntry[] = [];
    let totalBytes = 0;
    for (const rawName of [...consumes].sort()) {
      let name: string;
      try {
        name = normalizeArtifactName(rawName);
      } catch {
        throw new DependencyResolutionError(
          "FAIL_CLOSED_DEPENDENCY_RESOLUTION",
          `consume_name_invalid:${String(rawName).slice(0, 80)}`,
        );
      }
      const producers = planTasks.filter(
        (t) => isDepPredecessor(t) && producesOf(t).has(name),
      );
      if (producers.length === 0) {
        // Declared consume with no producing predecessor: under the
        // committed plan model this state should never exist — treat as
        // unresolvable rather than guessing a source.
        throw new DependencyResolutionError(
          "FAIL_CLOSED_DEPENDENCY_RESOLUTION",
          `unbound_consume:${name}`,
        );
      }
      if (producers.length > 1) {
        throw new DependencyResolutionError(
          "FAIL_CLOSED_DEPENDENCY_RESOLUTION",
          `ambiguous_producer:${name}`,
        );
      }
      const producer = producers[0]!;
      const candidate = this.resolveProducerArtifact(
        missionId,
        producer,
        name,
        planRevision,
      );
      if (!candidate) {
        if (isRemoteCapabilityTask(producer)) {
          // A remote file edge can never fall back to shared filesystem
          // semantics: no canonical artifact → the edge is ungoverned.
          throw new DependencyResolutionError(
            "FAIL_CLOSED_DEPENDENCY_RESOLUTION",
            `remote_producer_artifact_missing:${name}`,
          );
        }
        // Local producer without canonical artifact authority — legacy
        // path-only dependency stays outside this mechanism entirely.
        continue;
      }
      const { execution, artifact } = candidate;
      totalBytes += Number(artifact.byte_size);
      if (totalBytes > MAX_DEPENDENCY_ARTIFACT_TOTAL_BYTES) {
        throw new DependencyResolutionError(
          "FAIL_CLOSED_DEPENDENCY_RESOLUTION",
          `dependency_bytes>${MAX_DEPENDENCY_ARTIFACT_TOTAL_BYTES}`,
        );
      }
      const artifactId = String(artifact.artifact_id);
      entries.push({
        artifact_id: artifactId,
        producer_task_id: String(producer.task_id),
        producer_governed_task_id: String(execution.governed_task_id),
        producer_execution_id: String(execution.execution_id),
        producer_executor_id: String(execution.executor_id),
        logical_name: String(artifact.logical_name),
        sha256: String(artifact.sha256),
        byte_size: Number(artifact.byte_size),
        consumer_relative_path: dependencyConsumerPath(
          artifactId,
          String(artifact.logical_name),
        ),
        contract: DEPENDENCY_ARTIFACT_CONTRACT,
      });
    }
    return entries;
  }

  /**
   * The producer's canonical artifact for `logicalName`: the LATEST
   * producer execution carrying a terminal validation PASS whose
   * artifact_ids include a matching canonical artifact — re-verified
   * through the F1 authority at resolution time. Returns null when no
   * such artifact exists (caller decides legacy-skip vs fail).
   */
  private resolveProducerArtifact(
    missionId: string,
    producer: Record<string, unknown>,
    logicalName: string,
    planRevision: number,
  ): { execution: Record<string, unknown>; artifact: Record<string, unknown> } | null {
    const executions = this.store
      .list("executor_execution")
      .filter(
        (e) =>
          String(e.mission_id) === missionId &&
          String(e.task_id) === String(producer.task_id) &&
          Number(e.plan_revision) === planRevision &&
          String(e.execution_state) === "COMPLETED",
      )
      .sort((a, b) =>
        String(b.dispatch_timestamp ?? "").localeCompare(
          String(a.dispatch_timestamp ?? ""),
        ),
      );
    const validations = this.store.list("execution_validation");
    for (const exec of executions) {
      const pass = validations
        .filter(
          (v) =>
            String(v.execution_id) === String(exec.execution_id) &&
            String(v.status) === "PASS",
        )
        .pop();
      if (!pass) continue;
      const ids = Array.isArray(pass.artifact_ids)
        ? (pass.artifact_ids as unknown[]).map(String)
        : [];
      const matches: Array<Record<string, unknown>> = [];
      for (const id of ids) {
        const row = this.store.tryGet("artifact", id) as
          | Record<string, unknown>
          | null;
        if (!row || String(row.logical_name) !== logicalName) continue;
        if (String(row.execution_id) !== String(exec.execution_id)) continue;
        // §28 — a canonical-looking row is consumable only with real
        // F1 acceptance history: an injected ART (or a forged PASS row
        // referencing it) never becomes a handoff source.
        const accepted = this.store
          .listEvents("artifact", id)
          .some(
            (ev) =>
              String(ev.event_type) === "ARTIFACT_ACCEPTED" &&
              String(
                (ev.metadata as Record<string, unknown> | undefined)
                  ?.execution_id,
              ) === String(exec.execution_id),
          );
        if (!accepted) continue;
        // F1 re-verification NOW — a tampered/deleted retained object or
        // rewritten row never reaches the consumer pin.
        const verified = this.service.artifacts.verifyArtifactForConsumption(
          String(row.artifact_id),
          {
            execution_id: String(exec.execution_id),
            mission_id: missionId,
            task_id: String(producer.task_id),
            governed_task_id: String(exec.governed_task_id),
            producer_executor_id: String(exec.executor_id),
          },
        );
        matches.push(verified);
      }
      if (matches.length > 1) {
        throw new DependencyResolutionError(
          "FAIL_CLOSED_DEPENDENCY_RESOLUTION",
          `ambiguous_artifact:${logicalName}`,
        );
      }
      if (matches.length === 1) {
        return { execution: exec, artifact: matches[0]! };
      }
      // This exec passed validation but holds no matching artifact —
      // try the next earlier PASS execution (never re-baselines: the
      // entry binds the chosen execution id explicitly).
    }
    return null;
  }
}

/* ================================================================== */
/* ArtifactHandoffService                                              */
/* ================================================================== */

export type HandoffMode = "LOCAL_MATERIALIZATION" | "REMOTE_FETCH";

/**
 * Owns the durable `artifact_handoff` entity and both consumption lanes:
 *   - LOCAL_MATERIALIZATION: the exact retained CAS bytes land at
 *     workspace/.pair/dependency-artifacts/<ARTIFACT_ID>/<logical_name>
 *     via atomic tmp+fsync+rename, before the external executor call.
 *   - REMOTE_FETCH: /api/artifacts/fetch authorization — consume
 *     capability + CURRENT durable consumer state + pinned membership +
 *     F1 re-verification NOW → exact CAS bytes.
 */
export class ArtifactHandoffService {
  constructor(
    private readonly store: PairEvidenceStore,
    private readonly artifacts: ArtifactAuthority,
  ) {}

  /** PIN each resolved dependency onto the governed consumer task —
   *  called inside governed-task creation so the pin exists BEFORE any
   *  dispatch authorization. Idempotent: an existing handoff must bind
   *  the same fields or it fails closed. */
  pinForGovernedTask(
    governed: Record<string, unknown>,
    entries: DependencyArtifactEntry[],
    mode: HandoffMode,
  ): Array<Record<string, unknown>> {
    const pinned: Array<Record<string, unknown>> = [];
    for (const e of entries) {
      const handoffId = canonicalHandoffId(
        String(governed.governed_task_id),
        e.artifact_id,
        e.consumer_relative_path,
      );
      const existing = this.store.tryGet(HANDOFF_ENTITY, handoffId) as
        | Record<string, unknown>
        | null;
      const fields = {
        mission_id: String(governed.mission_id),
        artifact_id: e.artifact_id,
        producer_task_id: e.producer_task_id,
        producer_governed_task_id: e.producer_governed_task_id,
        producer_execution_id: e.producer_execution_id,
        producer_executor_id: e.producer_executor_id,
        consumer_task_id: String(governed.task_id),
        consumer_governed_task_id: String(governed.governed_task_id),
        consumer_executor_id: String(governed.executor_id),
        logical_name: e.logical_name,
        sha256: e.sha256,
        byte_size: e.byte_size,
        consumer_relative_path: e.consumer_relative_path,
        mode,
      };
      if (existing) {
        const mismatch = Object.entries(fields).find(
          ([k, v]) => String(existing[k] ?? null) !== String(v),
        );
        if (mismatch) {
          throw new DependencyResolutionError(
            "FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT",
            `${handoffId}:${mismatch[0]}`,
          );
        }
        pinned.push(existing);
        continue;
      }
      const row = this.store.put(
        HANDOFF_ENTITY,
        handoffId,
        {
          handoff_id: handoffId,
          contract: HANDOFF_CONTRACT,
          state: "PINNED",
          ...fields,
          created_at: utcnow(),
          updated_at: utcnow(),
          version: 0,
        },
        0,
      );
      this.store.event({
        entity_type: HANDOFF_ENTITY,
        entity_id: handoffId,
        event_type: "ARTIFACT_HANDOFF_PINNED",
        new_state: "PINNED",
        actor: "PAIR_ARTIFACT_HANDOFF",
        correlation_id: String(governed.correlation_id ?? ""),
        metadata: {
          mission_id: fields.mission_id,
          artifact_id: fields.artifact_id,
          consumer_task_id: fields.consumer_task_id,
          mode,
        },
      });
      pinned.push(row);
    }
    return pinned;
  }

  /**
   * LOCAL_MATERIALIZATION — materialize every pinned dependency into the
   * governed consumer workspace BEFORE the external executor call.
   * Idempotent (identical bytes converge), fail-closed on conflict /
   * symlink / traversal / tampered retained bytes.
   */
  materializeForConsumer(governed: Record<string, unknown>): string[] {
    const entries = (
      (governed.dependency_artifacts as unknown[] | undefined) ?? []
    ).map((e) => validateDependencyArtifactEntry(e));
    if (!entries.length) return [];
    const workspace = String(governed.workspace);
    const allowedPaths = (governed.allowed_paths as string[]) ?? [workspace];
    const materialized: string[] = [];
    for (const e of entries) {
      const handoff = this.requireHandoff(governed, e, "PINNED_MATERIALIZED");
      // Re-verify the canonical artifact AND read its retained bytes at
      // handoff time — never the producer's path, never row claims alone.
      const { bytes } = this.artifacts.readForConsumption(e.artifact_id);
      const dest = this.resolveConsumerDest(workspace, allowedPaths, e);
      if (fs.existsSync(dest) || fs.lstatSync(dest, { throwIfNoEntry: false })) {
        const st = fs.lstatSync(dest);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new DependencyResolutionError(
            "FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE",
            `${e.consumer_relative_path}:conflict`,
          );
        }
        const existing = secureReadContained(dest, MAX_ARTIFACT_BYTES, [
          path.resolve(workspace, DEPENDENCY_ARTIFACT_ROOT),
        ]);
        if (
          existing.kind === "ok" &&
          sha256Hex(existing.bytes) === e.sha256 &&
          existing.bytes.length === e.byte_size
        ) {
          // Identical bytes already pinned — converge, never rewrite.
          this.markState(handoff, "MATERIALIZED", governed);
          materialized.push(e.consumer_relative_path);
          continue;
        }
        throw new DependencyResolutionError(
          "FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE",
          `${e.consumer_relative_path}:existing_bytes_differ`,
        );
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
      const fh = fs.openSync(tmp, "w");
      try {
        fs.writeSync(fh, bytes);
        fs.fsyncSync(fh);
      } finally {
        fs.closeSync(fh);
      }
      fs.renameSync(tmp, dest);
      try {
        const dh = fs.openSync(path.dirname(dest), "r");
        try {
          fs.fsyncSync(dh);
        } finally {
          fs.closeSync(dh);
        }
      } catch (err) {
        const code = String((err as NodeJS.ErrnoException).code ?? "");
        if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(code)) {
          throw new DependencyResolutionError(
            "FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE",
            `${e.consumer_relative_path}:dir_fsync:${code}`,
          );
        }
      }
      // Post-write verification of the MATERIALIZED object (open-object
      // bound — a swapped path can never qualify).
      const written = secureReadContained(dest, MAX_ARTIFACT_BYTES, [
        path.resolve(workspace, DEPENDENCY_ARTIFACT_ROOT),
      ]);
      if (
        written.kind !== "ok" ||
        sha256Hex(written.bytes) !== e.sha256 ||
        written.bytes.length !== e.byte_size
      ) {
        throw new DependencyResolutionError(
          "FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE",
          `${e.consumer_relative_path}:post_write_mismatch`,
        );
      }
      this.markState(handoff, "MATERIALIZED", governed);
      materialized.push(e.consumer_relative_path);
    }
    return materialized;
  }

  /**
   * REMOTE_FETCH — /api/artifacts/fetch authorization. The consume
   * capability's claims must match CURRENT durable consumer state; the
   * artifact must be in the pinned dependency set (digest-bound); the
   * F1 authority re-verifies the retained bytes NOW. Returns the exact
   * bytes + row for the response.
   */
  authorizeConsumeFetch(
    claims: ArtifactConsumeCapabilityClaims,
    artifactId: string,
  ): { artifact: Record<string, unknown>; bytes: Buffer } {
    const reject = (reason: string): never => {
      throw new PolicyError("FAIL_CLOSED_ARTIFACT_CONSUME_REJECTED", reason);
    };
    const exec = this.store.tryGet("executor_execution", claims.execution_id) as
      | Record<string, unknown>
      | null;
    // The consumer execution must exist AND be authorized — a fetch
    // before the execution row is durable is never servable.
    if (!exec) reject("execution_unknown");
    const governed = this.store.tryGet(
      "governed_task",
      String(exec!.governed_task_id),
    ) as Record<string, unknown> | null;
    if (
      !governed ||
      String(exec!.mission_id) !== claims.mission_id ||
      String(exec!.task_id) !== claims.task_id ||
      String(exec!.governed_task_id) !== claims.governed_task_id ||
      String(exec!.execution_id) !== claims.execution_id ||
      String(exec!.executor_id) !== claims.executor_id ||
      String(governed.executor_id) !== claims.executor_id ||
      String(governed.mission_id) !== claims.mission_id ||
      String(governed.task_id) !== claims.task_id
    ) {
      reject("durable_identity");
    }
    // Lifecycle: a terminal execution or one with a persisted result is
    // closed — the capability can never be replayed after result.
    if (
      ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"].includes(
        String(exec!.execution_state),
      ) ||
      exec!.result != null
    ) {
      this.rejectHandoffEvent(governed!, artifactId, "consumer_closed");
      reject("consumer_closed");
    }
    const entries = (
      (governed!.dependency_artifacts as unknown[] | undefined) ?? []
    ).map((e) => validateDependencyArtifactEntry(e));
    // The pinned dependency set itself is bound into the capability —
    // mutating the pin after the capability was minted invalidates it.
    if (artifactDependencySetDigest(entries) !== claims.dependency_set_digest) {
      this.rejectHandoffEvent(governed!, artifactId, "dependency_set_mismatch");
      reject("dependency_set_mismatch");
    }
    const entry = entries.find((e) => e.artifact_id === artifactId);
    if (!entry) {
      this.rejectHandoffEvent(governed!, artifactId, "artifact_not_pinned");
      reject("artifact_not_pinned");
    }
    const handoff = this.requireHandoff(governed!, entry!, "PINNED_FETCHED");
    if (String(handoff.mode) !== "REMOTE_FETCH") {
      reject("handoff_mode");
    }
    const { artifact, bytes } = this.artifacts.readForConsumption(
      entry!.artifact_id,
    );
    // Handoff identity must still match the pinned entry — a rebound
    // handoff never serves bytes. The F1 row carries the producer
    // execution as `execution_id`.
    for (const f of ["sha256", "logical_name"] as const) {
      if (String(artifact[f]) !== String(entry![f])) {
        reject("handoff_identity");
      }
    }
    if (String(artifact.execution_id) !== entry!.producer_execution_id) {
      reject("handoff_identity");
    }
    if (sha256Hex(bytes) !== entry!.sha256 || bytes.length !== entry!.byte_size) {
      reject("bytes_mismatch");
    }
    if (String(handoff.state) === "PINNED") {
      this.markState(handoff, "FETCHED", governed!);
    }
    return { artifact, bytes };
  }

  /**
   * F2 §8 — pre-dispatch authority: the governed task's persisted
   * dependency_artifacts must equal the durable artifact_handoff pins
   * exactly, in both directions. A pin field mutated after governance —
   * or an entry removed, added, or rewritten — leaves the task NOT
   * dispatch-authorized. No-op for tasks without handoffs.
   */
  assertContractUnmutated(governed: Record<string, unknown>): void {
    const gtid = String(governed.governed_task_id);
    const handoffs = this.store
      .list(HANDOFF_ENTITY)
      .filter((h) => String(h.consumer_governed_task_id) === gtid);
    if (!handoffs.length) {
      // Zero pins + a non-empty contract = injected authority.
      const entries = governed.dependency_artifacts as unknown[] | undefined;
      if (Array.isArray(entries) && entries.length) {
        throw new DependencyResolutionError(
          "FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT",
          `${gtid}:unpinned_contract`,
        );
      }
      return;
    }
    const entries = (
      (governed.dependency_artifacts as unknown[] | undefined) ?? []
    ).map((e) => validateDependencyArtifactEntry(e));
    if (entries.length !== handoffs.length) {
      throw new DependencyResolutionError(
        "FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT",
        `${gtid}:pin_count`,
      );
    }
    for (const e of entries) {
      // State-agnostic: any pinned handoff may be PINNED/MATERIALIZED/
      // FETCHED depending on the consumption lane — binding integrity
      // is what dispatch authorization needs.
      this.assertHandoffBinding(governed, e);
    }
  }

  /* ------------------------- internals ---------------------------- */

  private requireHandoff(
    governed: Record<string, unknown>,
    entry: DependencyArtifactEntry,
    allowedStates: "PINNED_MATERIALIZED" | "PINNED_FETCHED",
  ): Record<string, unknown> {
    const handoffId = canonicalHandoffId(
      String(governed.governed_task_id),
      entry.artifact_id,
      entry.consumer_relative_path,
    );
    const row = this.store.tryGet(HANDOFF_ENTITY, handoffId) as
      | Record<string, unknown>
      | null;
    if (!row) {
      throw new DependencyResolutionError(
        "FAIL_CLOSED_ARTIFACT_HANDOFF_MISSING",
        handoffId,
      );
    }
    const allowed =
      allowedStates === "PINNED_MATERIALIZED"
        ? ["PINNED", "MATERIALIZED"]
        : ["PINNED", "FETCHED"];
    if (!allowed.includes(String(row.state))) {
      throw new DependencyResolutionError(
        "FAIL_CLOSED_ARTIFACT_HANDOFF_STATE",
        `${handoffId}:${String(row.state)}`,
      );
    }
    return this.assertHandoffBinding(governed, entry, row);
  }

  /** The handoff's own durable fields must equal the pinned contract —
   *  a rewritten row never silently serves. */
  private assertHandoffBinding(
    governed: Record<string, unknown>,
    entry: DependencyArtifactEntry,
    row?: Record<string, unknown>,
  ): Record<string, unknown> {
    const handoffId = canonicalHandoffId(
      String(governed.governed_task_id),
      entry.artifact_id,
      entry.consumer_relative_path,
    );
    const r =
      row ??
      (this.store.tryGet(HANDOFF_ENTITY, handoffId) as Record<
        string,
        unknown
      > | null);
    if (!r) {
      throw new DependencyResolutionError(
        "FAIL_CLOSED_ARTIFACT_HANDOFF_MISSING",
        handoffId,
      );
    }
    const bind: Record<string, unknown> = {
      mission_id: governed.mission_id,
      artifact_id: entry.artifact_id,
      producer_task_id: entry.producer_task_id,
      producer_governed_task_id: entry.producer_governed_task_id,
      producer_execution_id: entry.producer_execution_id,
      producer_executor_id: entry.producer_executor_id,
      consumer_task_id: governed.task_id,
      consumer_governed_task_id: governed.governed_task_id,
      logical_name: entry.logical_name,
      sha256: entry.sha256,
      byte_size: entry.byte_size,
      consumer_relative_path: entry.consumer_relative_path,
    };
    for (const [k, v] of Object.entries(bind)) {
      if (String(r[k] ?? null) !== String(v)) {
        throw new DependencyResolutionError(
          "FAIL_CLOSED_ARTIFACT_HANDOFF_CONFLICT",
          `${handoffId}:${k}`,
        );
      }
    }
    return r;
  }

  private resolveConsumerDest(
    workspace: string,
    allowedPaths: string[],
    entry: DependencyArtifactEntry,
  ): string {
    const rel = entry.consumer_relative_path;
    if (!rel.startsWith(`${DEPENDENCY_ARTIFACT_ROOT}/`)) {
      throw new DependencyResolutionError(
        "FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE",
        `${rel}:outside_handoff_root`,
      );
    }
    const dest = path.resolve(workspace, rel);
    if (!pathWithin(dest, workspace)) {
      throw new DependencyResolutionError(
        "FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE",
        `${rel}:outside_workspace`,
      );
    }
    if (!allowedPaths.some((ap) => pathWithin(dest, ap))) {
      throw new DependencyResolutionError(
        "FAIL_CLOSED_ARTIFACT_HANDOFF_MATERIALIZE",
        `${rel}:outside_allowed_paths`,
      );
    }
    return dest;
  }

  private markState(
    handoff: Record<string, unknown>,
    state: "MATERIALIZED" | "FETCHED",
    governed: Record<string, unknown>,
  ): void {
    if (String(handoff.state) === state) return;
    const row = this.store.get(HANDOFF_ENTITY, String(handoff.handoff_id));
    this.store.put(
      HANDOFF_ENTITY,
      String(row.handoff_id),
      { ...row, state, updated_at: utcnow() },
      Number(row.version),
    );
    this.store.event({
      entity_type: HANDOFF_ENTITY,
      entity_id: String(row.handoff_id),
      event_type:
        state === "MATERIALIZED"
          ? "ARTIFACT_HANDOFF_MATERIALIZED"
          : "ARTIFACT_HANDOFF_FETCHED",
      old_state: String(row.state),
      new_state: state,
      actor: "PAIR_ARTIFACT_HANDOFF",
      correlation_id: String(governed.correlation_id ?? ""),
      metadata: {
        mission_id: String(governed.mission_id),
        artifact_id: String(row.artifact_id),
        consumer_task_id: String(governed.task_id),
      },
    });
  }

  private rejectHandoffEvent(
    governed: Record<string, unknown>,
    artifactId: string,
    reason: string,
  ): void {
    try {
      this.store.appendEvidence(String(governed.mission_id), "ARTIFACT_HANDOFF_REJECTED", {
        consumer_governed_task_id: String(governed.governed_task_id),
        artifact_id: artifactId,
        reason,
      });
    } catch {
      /* evidence must never mask the rejection itself */
    }
  }
}

/** Stable canonical serialization of a dependency entry set — used for
 *  evidence and debugging, never as authority (the digest binds). */
export function dependencyArtifactsDigest(
  entries: DependencyArtifactEntry[],
): string {
  return artifactDependencySetDigest(
    entries.map((e) => ({ ...e }) as unknown as Record<string, unknown>),
  );
}
