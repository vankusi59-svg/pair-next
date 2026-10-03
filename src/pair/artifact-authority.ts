/**
 * F1 — canonical artifact authority.
 *
 * ONE identity model + ONE ingest seam for every artifact PAIR accepts.
 * An artifact is authoritative only when PAIR can prove the complete
 * identity chain: the executor_execution row exists, its
 * governed_task/mission/task linkage is consistent, the claimed producer
 * executor is the executor of record, the bytes were independently
 * hashed by PAIR into a content-addressed blob store, and (path
 * sources) the real filesystem path is contained under a governed
 * allowed root — parent-directory symlinks cannot escape it.
 *
 * Filename, workspace path, outbox presence, executor prose, and any
 * caller-provided sha256 are NEVER authority — only the canonical row +
 * retained CAS bytes are.
 *
 * Ordering (R1.4 — lost-response replay must converge):
 *   identity/linkage proof → name → bounded bytes → independent hash →
 *   deterministic ART identity → exact prior acceptance? converge
 *   idempotently (even after the execution closed — the proof is the
 *   already-minted row, not lifecycle) → else lifecycle gate → atomic
 *   count+mint transaction.
 *
 * Blob invariants (reusing the proven PR #30/R5 semantics):
 * - content-addressed: `blobs/<sha256>` is immutable after acceptance;
 * - dedup: identical bytes share one physical blob while provenance rows
 *   stay distinct per execution;
 * - crash-safe: deterministic tmp → fsync → atomic rename → parent-dir
 *   fsync → bounded re-verify; an orphan `.tmp` can never masquerade as a
 *   canonical blob (verify step reads the renamed path only);
 * - an orphan final blob (no artifact row) is inert storage, NEVER
 *   authority;
 * - stat-first bounded: no unbounded full read before the size bound.
 *
 * Idempotency: artifact identity is deterministic —
 * `canonicalArtifactId(execution_id, logical_name)`. A replay with the
 * SAME bytes converges to the existing row; DIFFERENT bytes under the
 * same identity fail closed (FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT) —
 * the original accepted bytes are never replaced.
 */
import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import {
  boundedFileSha256,
  canonicalArtifactId,
  pathWithin,
  sha256Hex,
  utcnow,
} from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";

/** F1 §9 — explicit artifact-layer bounds (a general workforce
 *  primitive, NOT Telegram-specific): 64 MiB canonical cap, 32 artifacts
 *  per execution, 200-byte logical names. Empty artifacts are rejected —
 *  a zero-byte payload carries no deliverable meaning. */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_EXECUTION = 32;
export const MAX_ARTIFACT_NAME_BYTES = 200;
export const ARTIFACT_ENTITY = "artifact";
export const ARTIFACT_CONTRACT = "pair-artifact.v1";

/** States in which artifact acceptance is closed. A COMPLETED/RUNNING
 *  execution may still accept (local settle validates post-COMPLETED;
 *  remote workers upload before their completion marker). FAILED,
 *  CANCELLED and TIMEOUT executions can never gain new artifact
 *  authority. */
const ARTIFACT_CLOSED_STATES = new Set(["FAILED", "CANCELLED", "TIMEOUT"]);

export type ArtifactIngestChannel = "LOCAL_EXECUTION" | "REMOTE_UPLOAD";

export interface ArtifactAcceptance {
  artifact: Record<string, unknown>;
  /** true when an identical previous acceptance was replayed — the same
   *  ART_* row is returned, no duplicate authority was minted. */
  replayed: boolean;
}

export interface ArtifactBatchAcceptance {
  artifacts: Array<Record<string, unknown>>;
  /** artifact_ids that resolved to an existing ACCEPTED row. */
  replayed: string[];
}

interface ProducerIdentity {
  mission_id: string;
  task_id: string;
  governed_task_id: string;
  /** Canonical containment roots for path sources — from the durable
   *  governed_task row, never the caller. */
  allowed_paths: string[];
}

interface PreparedArtifact {
  logical_name: string;
  artifact_id: string;
  bytes: Buffer;
  sha256: string;
  artifact_class: string;
}

/** F1 §9 — canonical logical-name normalizer. A logical name is a
 *  workspace-relative POSIX-style path used purely as identity, never as
 *  filesystem authority. Rejects absolute paths, traversal, backslashes,
 *  empty segments, NUL/control bytes, and over-length names. */
export function normalizeArtifactName(raw: unknown): string {
  const name = String(raw ?? "");
  if (!name || Buffer.byteLength(name, "utf8") > MAX_ARTIFACT_NAME_BYTES) {
    throw new IntegrityError(
      "FAIL_CLOSED_ARTIFACT_NAME_INVALID",
      `length=${Buffer.byteLength(name, "utf8")}`,
    );
  }
  if (/[\0-\x1f\\]/.test(name)) {
    throw new IntegrityError("FAIL_CLOSED_ARTIFACT_NAME_INVALID", "control/backslash");
  }
  const segs = name.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) {
    throw new IntegrityError("FAIL_CLOSED_ARTIFACT_NAME_INVALID", "empty/dot/dotdot segment");
  }
  if (path.isAbsolute(name) || name.startsWith("/")) {
    throw new IntegrityError("FAIL_CLOSED_ARTIFACT_NAME_INVALID", "absolute path");
  }
  return name;
}

export class ArtifactAuthority {
  constructor(
    private readonly store: PairEvidenceStore,
    private readonly opts: {
      blobDir: string;
      maxBytes?: number;
      maxPerExecution?: number;
    },
  ) {}

  private get maxBytes(): number {
    return this.opts.maxBytes ?? MAX_ARTIFACT_BYTES;
  }
  private get maxPerExecution(): number {
    return this.opts.maxPerExecution ?? MAX_ARTIFACTS_PER_EXECUTION;
  }

  /* ============================ public seams ============================ */

  /** The ONE canonical single-artifact ingest seam (F1 §4). All
   *  identities are resolved from durable PAIR state — a caller supplies
   *  only the claimed execution_id + producer_executor_id and the
   *  bytes/path; every other identity dimension is verified against
   *  canonical rows. */
  accept(args: {
    execution_id: string;
    producer_executor_id: string;
    logical_name: string;
    source: { kind: "path"; path: string } | { kind: "buffer"; bytes: Buffer };
    channel: ArtifactIngestChannel;
    actor: string;
    correlation_id?: string | null;
    /** Remote uploads must close once the execution result is persisted;
     *  local settle-time validation accepts with the result present. */
    allow_post_result?: boolean;
  }): ArtifactAcceptance {
    const batch = this.acceptBatch({
      execution_id: args.execution_id,
      producer_executor_id: args.producer_executor_id,
      items: [{ logical_name: args.logical_name, source: args.source }],
      channel: args.channel,
      actor: args.actor,
      correlation_id: args.correlation_id,
      allow_post_result: args.allow_post_result,
    });
    const artifact = batch.artifacts[0]!;
    return { artifact, replayed: batch.replayed.includes(String(artifact.artifact_id)) };
  }

  /** R1.6 — canonical batch ingest: ONE atomic mint for a whole local
   *  validation batch. Every item resolves identity/bytes/replay inside
   *  a single serialized transaction — a failure anywhere mints ZERO new
   *  rows (previously accepted rows are never deleted, and replayed
   *  items still converge inside the batch). */
  acceptBatch(args: {
    execution_id: string;
    producer_executor_id: string;
    items: Array<{
      logical_name: string;
      source: { kind: "path"; path: string } | { kind: "buffer"; bytes: Buffer };
    }>;
    channel: ArtifactIngestChannel;
    actor: string;
    correlation_id?: string | null;
    allow_post_result?: boolean;
  }): ArtifactBatchAcceptance {
    const store = this.store;
    const missionId = this.resolveMissionId(args.execution_id);
    const identity = this.verifyIdentity(args.execution_id, args.producer_executor_id);

    // ---- stage 1: canonicalize names + materialize bounded bytes ----
    const prepared: PreparedArtifact[] = [];
    const seenNames = new Set<string>();
    for (const item of args.items) {
      const logicalName = normalizeArtifactName(item.logical_name);
      if (seenNames.has(logicalName)) {
        throw new IntegrityError(
          "FAIL_CLOSED_ARTIFACT_NAME_INVALID",
          `duplicate logical name in batch: ${logicalName}`,
        );
      }
      seenNames.add(logicalName);
      const bytes = this.materialize(item.source, identity, {
        mission_id: missionId,
        logical_name: logicalName,
        actor: args.actor,
        correlation_id: args.correlation_id,
        execution_id: args.execution_id,
      });
      prepared.push({
        logical_name: logicalName,
        artifact_id: canonicalArtifactId(args.execution_id, logicalName),
        bytes,
        sha256: sha256Hex(bytes),
        artifact_class: artifactClass(logicalName),
      });
    }

    // ---- stage 2: exact-prior convergence BEFORE lifecycle (R1.4) ----
    // An identical already-accepted artifact converges idempotently even
    // when the execution has since closed — retrieving existing
    // authority is never a new mint. Different bytes under an existing
    // identity fail closed as REPLAY_CONFLICT at the same check. A
    // forged execution_id cannot reach here: identity and linkage were
    // verified above.
    let allPrior = prepared.length > 0;
    for (const p of prepared) {
      const prior = store.tryGet(ARTIFACT_ENTITY, p.artifact_id) as
        | Record<string, unknown>
        | null;
      if (!prior) {
        allPrior = false;
        continue;
      }
      if (String(prior.sha256) !== p.sha256) {
        throw new IntegrityError(
          "FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT",
          `${p.artifact_id}:${p.logical_name}`,
        );
      }
      if (String(prior.state) !== "ACCEPTED") allPrior = false;
    }
    if (allPrior) {
      const artifacts = prepared.map(
        (p) => store.get(ARTIFACT_ENTITY, p.artifact_id) as Record<string, unknown>,
      );
      store.event({
        entity_type: ARTIFACT_ENTITY,
        entity_id: prepared[0]!.artifact_id,
        event_type: "ARTIFACT_INGEST_IDEMPOTENT",
        new_state: "ACCEPTED",
        actor: args.actor,
        correlation_id: args.correlation_id ?? null,
        metadata: {
          execution_id: args.execution_id,
          count: prepared.length,
        },
      });
      return { artifacts, replayed: artifacts.map((a) => String(a.artifact_id)) };
    }

    // ---- stage 3: lifecycle gate — NEW authority requires openness ----
    this.assertOpen(args.execution_id, args.allow_post_result === true, {
      mission_id: missionId,
      actor: args.actor,
      correlation_id: args.correlation_id,
    });

    // ---- stage 4: persist required blobs (orphan CAS = inert, never
    // authority) before the DB authority transaction ----
    for (const p of prepared) this.persistBlob(p.sha256, p.bytes);

    // ---- stage 5: ONE serialized transaction — prior/recount + cap +
    // mint all rows+events+evidence atomically (R1.1). Two racing
    // writers serialize on the SQLite write lock; the losing writer
    // re-reads committed state inside its own txn and converges. ----
    const replayed: string[] = [];
    const artifacts: Array<Record<string, unknown>> = [];
    store.immediate(() => {
      // Recount + re-check priors INSIDE the atomic window — a stale
      // pre-transaction read can never authorize two writers past the cap.
      let count = store
        .list(ARTIFACT_ENTITY)
        .filter(
          (a) =>
            String(a.execution_id) === args.execution_id &&
            String(a.contract ?? "") === ARTIFACT_CONTRACT,
        ).length;
      for (const p of prepared) {
        const prior = store.tryGet(ARTIFACT_ENTITY, p.artifact_id) as
          | Record<string, unknown>
          | null;
        if (prior) {
          if (String(prior.sha256) === p.sha256 && String(prior.state) === "ACCEPTED") {
            replayed.push(p.artifact_id);
            artifacts.push(prior);
            continue;
          }
          throw new IntegrityError(
            "FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT",
            `${p.artifact_id}:${p.logical_name}`,
          );
        }
        if (count >= this.maxPerExecution) {
          throw new IntegrityError(
            "FAIL_CLOSED_ARTIFACT_COUNT_EXCEEDED",
            `${args.execution_id}:${count}`,
          );
        }
        const row: Record<string, unknown> = {
          artifact_id: p.artifact_id,
          execution_id: args.execution_id,
          governed_task_id: identity.governed_task_id,
          mission_id: missionId,
          task_id: identity.task_id,
          producer_executor_id: args.producer_executor_id,
          logical_name: p.logical_name,
          artifact_class: p.artifact_class,
          sha256: p.sha256,
          byte_size: p.bytes.length,
          state: "ACCEPTED",
          contract: ARTIFACT_CONTRACT,
          ingested_via: args.channel,
          storage: { kind: "PAIR_ARTIFACT_CAS", ref: `blobs/${p.sha256}`, sha256: p.sha256 },
          created_at: utcnow(),
          version: 0,
        };
        store.put(ARTIFACT_ENTITY, p.artifact_id, row, 0);
        store.event({
          entity_type: ARTIFACT_ENTITY,
          entity_id: p.artifact_id,
          event_type: "ARTIFACT_ACCEPTED",
          new_state: p.logical_name,
          actor: args.actor,
          correlation_id: args.correlation_id ?? null,
          metadata: {
            execution_id: args.execution_id,
            producer_executor_id: args.producer_executor_id,
            sha256: p.sha256,
            byte_size: p.bytes.length,
            channel: args.channel,
          },
        });
        store.appendEvidence(missionId, "ARTIFACT_ACCEPTED", {
          artifact_id: p.artifact_id,
          execution_id: args.execution_id,
          governed_task_id: identity.governed_task_id,
          task_id: identity.task_id,
          producer_executor_id: args.producer_executor_id,
          logical_name: p.logical_name,
          sha256: p.sha256,
          byte_size: p.bytes.length,
          channel: args.channel,
        });
        artifacts.push(row);
        count++;
      }
    });
    return { artifacts, replayed };
  }

  /* ============================ read model ============================ */

  /** Canonical artifacts accepted for one execution — restart-safe
   *  reconstruction of the producer's artifact references without any
   *  re-upload or re-baselining (F1 §7). */
  forExecution(executionId: string): Array<Record<string, unknown>> {
    return this.store
      .list(ARTIFACT_ENTITY)
      .filter(
        (a) =>
          String(a.execution_id) === executionId &&
          String(a.contract ?? "") === ARTIFACT_CONTRACT &&
          String(a.state) === "ACCEPTED",
      );
  }

  /** Read-model projection (F1 §10): canonical fields only — no host
   *  filesystem path is exposed as external authority. Pre-F1 rows
   *  (path-only provenance) remain inspectable as LEGACY_PATH_ONLY. */
  project(row: Record<string, unknown>): Record<string, unknown> {
    const canonical = String(row.contract ?? "") === ARTIFACT_CONTRACT;
    return {
      artifact_id: row.artifact_id,
      mission_id: row.mission_id,
      task_id: row.task_id,
      governed_task_id: row.governed_task_id,
      execution_id: row.execution_id,
      producer_executor_id: row.producer_executor_id ?? null,
      logical_name: row.logical_name ?? row.path ?? null,
      artifact_class: row.artifact_class ?? null,
      sha256: row.sha256,
      byte_size: row.byte_size,
      state: canonical ? row.state : "LEGACY_PATH_ONLY",
      canonical,
      created_at: row.created_at ?? null,
      storage_ref: canonical ? `pair-artifact://sha256/${String(row.sha256)}` : null,
    };
  }

  list(missionId?: string): Array<Record<string, unknown>> {
    return this.store
      .list(ARTIFACT_ENTITY)
      .filter((a) => !missionId || String(a.mission_id) === missionId)
      .map((a) => this.project(a));
  }

  get(artifactId: string): Record<string, unknown> | null {
    const row = this.store.tryGet(ARTIFACT_ENTITY, artifactId) as
      | Record<string, unknown>
      | null;
    return row ? this.project(row) : null;
  }

  /** Sweep orphan staging files (`<sha>.tmp-*`) left by a crash between
   *  write/fsync and rename. Never touches canonical blobs. */
  sweepTmp(): number {
    let n = 0;
    try {
      for (const f of fs.readdirSync(this.opts.blobDir)) {
        if (f.includes(".tmp-")) {
          try {
            fs.unlinkSync(path.join(this.opts.blobDir, f));
            n++;
          } catch {
            /* already gone */
          }
        }
      }
    } catch {
      /* dir absent */
    }
    return n;
  }

  /* ============================ internals ============================ */

  private resolveMissionId(executionId: string): string {
    const e = this.store.tryGet("executor_execution", executionId) as
      | Record<string, unknown>
      | null;
    return String(e?.mission_id ?? "");
  }

  /** Durable identity + linkage proof (always mandatory — BEFORE any
   *  lifecycle decision so an exact replay can converge post-close).
   *  Returns the resolved identity and the governed allowed_roots. */
  private verifyIdentity(executionId: string, producerExecutorId: string): ProducerIdentity {
    const store = this.store;
    const execution = store.tryGet("executor_execution", executionId) as
      | Record<string, unknown>
      | null;
    if (!execution) {
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_EXECUTION_UNKNOWN", executionId);
    }
    const governed = store.tryGet(
      "governed_task",
      String(execution.governed_task_id),
    ) as Record<string, unknown> | null;
    if (!governed) {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_LINKAGE",
        `governed_task:${String(execution.governed_task_id)}`,
      );
    }
    if (
      String(execution.mission_id) !== String(governed.mission_id) ||
      String(execution.task_id) !== String(governed.task_id)
    ) {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_LINKAGE",
        `${executionId}:mission/task mismatch`,
      );
    }
    if (String(execution.executor_id) !== String(producerExecutorId)) {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_PRODUCER_MISMATCH",
        `${executionId}:${producerExecutorId}`,
      );
    }
    const allowed =
      (Array.isArray(governed.allowed_paths) && (governed.allowed_paths as string[]).length
        ? (governed.allowed_paths as string[]).map(String)
        : [String(governed.workspace ?? "")]) ?? [];
    return {
      mission_id: String(execution.mission_id),
      task_id: String(execution.task_id),
      governed_task_id: String(execution.governed_task_id),
      allowed_paths: allowed,
    };
  }

  /** Lifecycle gate — only NEW authority mints pass through here. An
   *  exact prior acceptance already converged in stage 2 and never
   *  reaches this gate (R1.4). */
  private assertOpen(
    executionId: string,
    allowPostResult: boolean,
    ev: { mission_id: string; actor: string; correlation_id?: string | null },
  ): void {
    const execution = this.store.get("executor_execution", executionId) as
      | Record<string, unknown>;
    const state = String(execution.execution_state ?? "");
    const closed = ARTIFACT_CLOSED_STATES.has(state);
    const postResult = !allowPostResult && execution.result != null;
    if (closed || postResult) {
      const reason = closed ? state : "result persisted";
      this.rejectMeta(ev.mission_id, {
        execution_id: executionId,
        logical_name: "",
        actor: ev.actor,
        correlation_id: ev.correlation_id,
      }, "ARTIFACT_EXECUTION_CLOSED", `${state}`);
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_EXECUTION_CLOSED",
        `${executionId}:${reason}`,
      );
    }
  }

  /** Bounded materialization + R1.2 real-path containment for path
   *  sources: the REAL resolved path must live inside a governed allowed
   *  root — parent-directory symlink escapes fail closed. */
  private materialize(
    source: { kind: "path"; path: string } | { kind: "buffer"; bytes: Buffer },
    identity: ProducerIdentity,
    ev: {
      mission_id: string;
      logical_name: string;
      actor: string;
      correlation_id?: string | null;
      execution_id: string;
    },
  ): Buffer {
    if (source.kind === "buffer") {
      const bytes = source.bytes;
      if (!Buffer.isBuffer(bytes) || bytes.length > this.maxBytes) {
        this.rejectMeta(ev.mission_id, ev, "ARTIFACT_TOO_LARGE", `size=${bytes?.length ?? -1}`);
        throw new IntegrityError(
          "FAIL_CLOSED_ARTIFACT_TOO_LARGE",
          `size=${bytes?.length ?? -1}`,
        );
      }
      if (bytes.length === 0) {
        this.rejectMeta(ev.mission_id, ev, "ARTIFACT_EMPTY", ev.logical_name);
        throw new IntegrityError("FAIL_CLOSED_ARTIFACT_EMPTY", ev.logical_name);
      }
      return bytes;
    }
    this.assertContained(source.path, identity.allowed_paths, ev);
    const br = boundedFileSha256(source.path, this.maxBytes);
    if (br.kind === "too_large") {
      this.rejectMeta(ev.mission_id, ev, "ARTIFACT_TOO_LARGE", `size=${br.size}`);
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_TOO_LARGE", `size=${br.size}`);
    }
    if (br.kind !== "ok") {
      this.rejectMeta(ev.mission_id, ev, "ARTIFACT_UNRESOLVED", source.path);
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_UNRESOLVED", source.path);
    }
    if (br.bytes.length === 0) {
      this.rejectMeta(ev.mission_id, ev, "ARTIFACT_EMPTY", ev.logical_name);
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_EMPTY", ev.logical_name);
    }
    return br.bytes;
  }

  /** R1.2 — real filesystem containment. `lstat(final)` alone misses a
   *  parent-directory symlink (`ws/link -> /outside`; `link/x.bin` is a
   *  regular file). The canonical seam resolves the real path of the
   *  source and requires it under the real path of a governed allowed
   *  root — plus keeps the strict final-component symlink rejection. */
  private assertContained(
    source: string,
    allowedPaths: string[],
    ev: {
      mission_id: string;
      logical_name: string;
      actor: string;
      correlation_id?: string | null;
      execution_id: string;
    },
  ): void {
    try {
      if (fs.lstatSync(source).isSymbolicLink()) {
        this.rejectMeta(ev.mission_id, ev, "ARTIFACT_SYMLINK", source);
        throw new IntegrityError("FAIL_CLOSED_ARTIFACT_SYMLINK", source);
      }
    } catch (e) {
      if (e instanceof IntegrityError) throw e;
      this.rejectMeta(ev.mission_id, ev, "ARTIFACT_UNRESOLVED", source);
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_UNRESOLVED", source);
    }
    let real: string;
    try {
      real = fs.realpathSync(source);
    } catch {
      this.rejectMeta(ev.mission_id, ev, "ARTIFACT_UNRESOLVED", source);
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_UNRESOLVED", source);
    }
    const inside = allowedPaths.some((ap) => {
      try {
        return pathWithin(real, fs.realpathSync(ap));
      } catch {
        return false;
      }
    });
    if (!inside) {
      this.rejectMeta(ev.mission_id, ev, "ARTIFACT_PATH_OUTSIDE", `${source}->${real}`);
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_PATH_OUTSIDE",
        `${source} resolves outside allowed_paths`,
      );
    }
  }

  private persistBlob(sha256: string, bytes: Buffer): void {
    const dir = this.opts.blobDir;
    const dest = path.join(dir, sha256);
    const existing = boundedFileSha256(dest, this.maxBytes);
    if (existing.kind === "ok" && existing.sha256 === sha256) return;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${sha256}.tmp-${process.pid}-${ulid()}`);
    const fh = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fh, bytes);
      fs.fsyncSync(fh);
    } finally {
      fs.closeSync(fh);
    }
    fs.renameSync(tmp, dest);
    // R1.9 — commit the directory entry too: without a parent-dir fsync
    // a power-loss can drop the rename while data itself was durable.
    // Filesystems that cannot fsync a directory (EINVAL/ENOTSUP) degrade
    // deliberately — the post-rename content verify still applies.
    try {
      const dfd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      /* platform without directory fsync — documented fallback */
    }
    const post = boundedFileSha256(dest, this.maxBytes);
    if (post.kind !== "ok" || post.sha256 !== sha256) {
      try {
        fs.unlinkSync(dest);
      } catch {
        /* leave torn blob for sweep */
      }
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_BLOB_WRITE", sha256);
    }
  }

  private rejectMeta(
    missionId: string,
    args: { execution_id: string; logical_name: string; actor: string; correlation_id?: string | null },
    reason: string,
    detail: string,
  ): void {
    try {
      this.store.event({
        entity_type: "executor_execution",
        entity_id: args.execution_id,
        event_type: "ARTIFACT_REJECTED",
        new_state: reason,
        actor: args.actor,
        correlation_id: args.correlation_id ?? null,
        metadata: { logical_name: args.logical_name, detail },
      });
      if (missionId) {
        this.store.appendEvidence(missionId, "ARTIFACT_REJECTED", {
          execution_id: args.execution_id,
          logical_name: args.logical_name,
          reason,
          detail,
        });
      }
    } catch {
      /* evidence write failure must not mask the primary rejection */
    }
  }
}

/** Extension→classification hint; metadata/policy only, never content
 *  identity (bytes are identified solely by sha256). */
function artifactClass(logicalName: string): string {
  const ext = path.extname(logicalName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"].includes(ext)) return "image";
  if ([".md", ".txt", ".log", ".csv", ".tsv", ".json", ".xml", ".html"].includes(ext))
    return "text";
  return "binary";
}
