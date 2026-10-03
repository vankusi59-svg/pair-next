/**
 * F1 — canonical artifact authority.
 *
 * ONE identity model + ONE ingest seam for every artifact PAIR accepts.
 * An artifact is authoritative only when PAIR can prove the complete
 * identity chain: the executor_execution row exists, its
 * governed_task/mission/task linkage is consistent, the claimed producer
 * executor is the executor of record, and the bytes were independently
 * hashed by PAIR into a content-addressed blob store.
 *
 * Filename, workspace path, outbox presence, executor prose, and any
 * caller-provided sha256 are NEVER authority — only the canonical row +
 * retained CAS bytes are.
 *
 * Blob invariants (reusing the proven PR #30/R5 semantics):
 * - content-addressed: `blobs/<sha256>` is immutable after acceptance;
 * - dedup: identical bytes share one physical blob while provenance rows
 *   stay distinct per execution;
 * - crash-safe: deterministic tmp → fsync → atomic rename; an orphan
 *   `.tmp` can never masquerade as a canonical blob (verify step reads
 *   the renamed path only);
 * - stat-first bounded: no unbounded full read before the size bound
 *   (boundedFileSha256 for path sources; explicit length check for
 *   already-materialized buffers).
 *
 * Idempotency: artifact identity is deterministic —
 * `canonicalArtifactId(execution_id, logical_name)`. A replay with the
 * SAME bytes converges to the existing row (idempotent accept, no
 * duplicate authority). A replay under the same identity with DIFFERENT
 * bytes fails closed (FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT) — the
 * original accepted bytes are never replaced.
 */
import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import {
  boundedFileSha256,
  canonicalArtifactId,
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

  /** The ONE canonical ingest seam (F1 §4). All identities are resolved
   *  from durable PAIR state — a caller supplies only the claimed
   *  execution_id + producer_executor_id and the bytes/path; every other
   *  identity dimension is verified against canonical rows. */
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
    const store = this.store;
    const identity = this.verifyProducer(args);
    const missionId = identity.mission_id;
    const logicalName = normalizeArtifactName(args.logical_name);

    // Replay/idempotency identity: deterministic per producer+name.
    const artifactId = canonicalArtifactId(args.execution_id, logicalName);
    const prior = store.tryGet(ARTIFACT_ENTITY, artifactId) as
      | (Record<string, unknown> & { version: number })
      | null;

    // Count bound (count only distinct names for this execution).
    const existing = store
      .list(ARTIFACT_ENTITY)
      .filter((a) => String(a.execution_id) === args.execution_id);
    if (!prior && existing.length >= this.maxPerExecution) {
      this.reject(missionId, args, "ARTIFACT_COUNT_EXCEEDED", `count=${existing.length}`);
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_COUNT_EXCEEDED", args.execution_id);
    }

    // Byte materialization — stat-first bounded for paths; explicit
    // length bound for buffers (already materialized by the caller's own
    // bounded transport).
    let bytes: Buffer;
    if (args.source.kind === "path") {
      this.assertNotSymlink(args.source.path);
      const br = boundedFileSha256(args.source.path, this.maxBytes);
      if (br.kind === "too_large") {
        this.reject(missionId, args, "ARTIFACT_TOO_LARGE", `size=${br.size}`);
        throw new IntegrityError("FAIL_CLOSED_ARTIFACT_TOO_LARGE", `size=${br.size}`);
      }
      if (br.kind !== "ok") {
        this.reject(missionId, args, "ARTIFACT_UNRESOLVED", args.source.path);
        throw new IntegrityError("FAIL_CLOSED_ARTIFACT_UNRESOLVED", args.source.path);
      }
      bytes = br.bytes;
    } else {
      bytes = args.source.bytes;
      if (!Buffer.isBuffer(bytes) || bytes.length > this.maxBytes) {
        this.reject(missionId, args, "ARTIFACT_TOO_LARGE", `size=${bytes?.length ?? -1}`);
        throw new IntegrityError(
          "FAIL_CLOSED_ARTIFACT_TOO_LARGE",
          `size=${bytes?.length ?? -1}`,
        );
      }
    }
    if (bytes.length === 0) {
      this.reject(missionId, args, "ARTIFACT_EMPTY", logicalName);
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_EMPTY", logicalName);
    }

    // PAIR independently hashes the bytes — a caller-provided sha256 is
    // never consulted for identity.
    const sha256 = boundedSha(bytes);

    // Replay convergence: same identity + same bytes → the existing row
    // (no duplicate authority); same identity + different bytes → fail
    // closed, the original bytes are never replaced.
    if (prior) {
      if (String(prior.sha256) === sha256 && String(prior.state) === "ACCEPTED") {
        store.event({
          entity_type: ARTIFACT_ENTITY,
          entity_id: artifactId,
          event_type: "ARTIFACT_INGEST_IDEMPOTENT",
          new_state: "ACCEPTED",
          actor: args.actor,
          correlation_id: args.correlation_id ?? null,
          metadata: { execution_id: args.execution_id, logical_name: logicalName },
        });
        return { artifact: prior, replayed: true };
      }
      this.reject(missionId, args, "ARTIFACT_REPLAY_CONFLICT", `${artifactId}`);
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT",
        `${artifactId}:${logicalName}`,
      );
    }

    // Canonical bytes into CAS: dedup by sha; tmp → fsync → rename; the
    // stored blob is then re-verified stat-first so a torn write can
    // never masquerade as canonical.
    this.persistBlob(sha256, bytes);

    const row: Record<string, unknown> = {
      artifact_id: artifactId,
      execution_id: args.execution_id,
      governed_task_id: identity.governed_task_id,
      mission_id: missionId,
      task_id: identity.task_id,
      producer_executor_id: args.producer_executor_id,
      logical_name: logicalName,
      artifact_class: artifactClass(logicalName),
      sha256,
      byte_size: bytes.length,
      state: "ACCEPTED",
      contract: ARTIFACT_CONTRACT,
      ingested_via: args.channel,
      storage: {
        kind: "PAIR_ARTIFACT_CAS",
        ref: `blobs/${sha256}`,
        sha256,
      },
      created_at: utcnow(),
      version: 0,
    };

    try {
      store.immediate(() => {
        store.put(ARTIFACT_ENTITY, artifactId, row, 0);
        store.event({
          entity_type: ARTIFACT_ENTITY,
          entity_id: artifactId,
          event_type: "ARTIFACT_ACCEPTED",
          new_state: logicalName,
          actor: args.actor,
          correlation_id: args.correlation_id ?? null,
          metadata: {
            execution_id: args.execution_id,
            producer_executor_id: args.producer_executor_id,
            sha256,
            byte_size: bytes.length,
            channel: args.channel,
          },
        });
        store.appendEvidence(missionId, "ARTIFACT_ACCEPTED", {
          artifact_id: artifactId,
          execution_id: args.execution_id,
          governed_task_id: identity.governed_task_id,
          task_id: identity.task_id,
          producer_executor_id: args.producer_executor_id,
          logical_name: logicalName,
          sha256,
          byte_size: bytes.length,
          channel: args.channel,
        });
      });
    } catch (e) {
      // Lost create race (concurrent duplicate ingest): the winner's row
      // is the authority — converge idempotently when its bytes match.
      if (e instanceof IntegrityError && e.code === "FAIL_CLOSED_VERSION_CONFLICT") {
        const winner = store.tryGet(ARTIFACT_ENTITY, artifactId) as
          | Record<string, unknown>
          | null;
        if (winner && String(winner.sha256) === sha256) {
          return { artifact: winner, replayed: true };
        }
      }
      throw e;
    }
    return { artifact: row, replayed: false };
  }

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
      storage_ref: canonical
        ? `pair-artifact://sha256/${String(row.sha256)}`
        : null,
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

  /** Verify the claimed producer context against canonical rows and
   *  return the derived identity — identity is resolved from durable
   *  state, never supplied by the caller. */
  private verifyProducer(args: {
    execution_id: string;
    producer_executor_id: string;
    channel: ArtifactIngestChannel;
    actor: string;
    correlation_id?: string | null;
    allow_post_result?: boolean;
  }): { mission_id: string; task_id: string; governed_task_id: string } {
    // All producer identity dimensions verified below come from durable
    // canonical rows — never from caller-supplied identity fields.
    const store = this.store;
    const execution = store.tryGet("executor_execution", args.execution_id) as
      | Record<string, unknown>
      | null;
    if (!execution) {
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_EXECUTION_UNKNOWN", args.execution_id);
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
    // Linkage consistency: the execution's own mission/task must equal
    // the governed task's canonical mission/task.
    if (
      String(execution.mission_id) !== String(governed.mission_id) ||
      String(execution.task_id) !== String(governed.task_id)
    ) {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_LINKAGE",
        `${args.execution_id}:mission/task mismatch`,
      );
    }
    if (String(execution.executor_id) !== String(args.producer_executor_id)) {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_PRODUCER_MISMATCH",
        `${args.execution_id}:${args.producer_executor_id}`,
      );
    }
    const state = String(execution.execution_state ?? "");
    if (ARTIFACT_CLOSED_STATES.has(state)) {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_EXECUTION_CLOSED",
        `${args.execution_id}:${state}`,
      );
    }
    if (args.allow_post_result === false && execution.result != null) {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_EXECUTION_CLOSED",
        `${args.execution_id}:result persisted`,
      );
    }
    return {
      mission_id: String(execution.mission_id),
      task_id: String(execution.task_id),
      governed_task_id: String(execution.governed_task_id),
    };
  }

  private assertNotSymlink(p: string): void {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) {
        throw new IntegrityError("FAIL_CLOSED_ARTIFACT_SYMLINK", p);
      }
    } catch (e) {
      if (e instanceof IntegrityError) throw e;
      /* stat failure falls through to the bounded read, which resolves */
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

  private reject(
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
      this.store.appendEvidence(missionId, "ARTIFACT_REJECTED", {
        execution_id: args.execution_id,
        logical_name: args.logical_name,
        reason,
        detail,
      });
    } catch {
      /* evidence write failure must not mask the primary rejection */
    }
  }
}

function boundedSha(bytes: Buffer): string {
  return sha256Hex(bytes);
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
