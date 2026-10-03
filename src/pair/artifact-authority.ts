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
  canonicalArtifactId,
  secureReadContained,
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

/** Immutable facts an ARTIFACT_ACCEPTED event records — the history a
 *  current row must still match (R7.2). */
interface AcceptedArtifactFacts {
  logical_name: string;
  producer_executor_id: string;
  sha256: string;
  byte_size: number;
  channel: string;
}

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

  /** F4 — deterministic retained-CAS object path for a verified digest.
   *  The blob name IS the digest, so the path alone grants no authority —
   *  readers still re-verify bytes against the pinned sha256 before use
   *  (delivery snapshot staging does exactly that). */
  casBlobPath(sha256: string): string {
    return path.join(this.opts.blobDir, sha256);
  }

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
      /** R2.2 — worker-declared expectations, verified inside the ONE
       *  materialization: the exact bytes read once here are the bytes
       *  hashed, CAS-retained and row-minted. */
      expected_sha256?: string;
      expected_byte_size?: number;
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
      const sha = sha256Hex(bytes);
      // R2.2 — declared identity verified against THE materialized
      // buffer: a file that changed between a caller's own earlier
      // check and this read can never mint canonical bytes != declared.
      if (item.expected_sha256 !== undefined && item.expected_sha256 !== sha) {
        throw new IntegrityError(
          "FAIL_CLOSED_ARTIFACT_DECLARED_MISMATCH",
          `${logicalName}:sha256`,
        );
      }
      if (
        item.expected_byte_size !== undefined &&
        Number(item.expected_byte_size) !== bytes.length
      ) {
        throw new IntegrityError(
          "FAIL_CLOSED_ARTIFACT_DECLARED_MISMATCH",
          `${logicalName}:byte_size`,
        );
      }
      prepared.push({
        logical_name: logicalName,
        artifact_id: canonicalArtifactId(args.execution_id, logicalName),
        bytes,
        sha256: sha,
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
      // R2.3 — a same-sha ACCEPTED row is NOT enough: only a fully
      // canonical F1 prior (contract + every identity dimension +
      // retained CAS bytes verifying to this digest) may satisfy a
      // post-close idempotent replay. Legacy/malformed rows fail closed.
      if (!this.isCanonicalPrior(prior, p, identity, args)) {
        throw new IntegrityError(
          "FAIL_CLOSED_ARTIFACT_REPLAY_CONFLICT",
          `${p.artifact_id}:noncanonical-prior`,
        );
      }
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
          if (
            String(prior.sha256) === p.sha256 &&
            this.isCanonicalPrior(prior, p, identity, args)
          ) {
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

  /** R5.2 — terminal re-verification: every candidate ACCEPTED
   *  pair-artifact.v1 row for this execution must prove the COMPLETE
   *  canonical contract AND that its retained CAS bytes verify NOW.
   *  A malformed row, a tampered storage ref, or a missing/corrupted/
   *  symlinked retained object fails closed — it is never silently
   *  dropped so the execution can pass around it.
   *  Returns the verified artifact_ids (PASS authority). */
  verifyForExecution(executionId: string): string[] {
    const execution = this.store.tryGet("executor_execution", executionId) as
      | Record<string, unknown>
      | null;
    if (!execution) {
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_EXECUTION_UNKNOWN", executionId);
    }
    const governed = this.store.tryGet(
      "governed_task",
      String(execution.governed_task_id),
    ) as Record<string, unknown> | null;
    if (!governed) {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_VERIFICATION",
        `${executionId}:governed_task_missing`,
      );
    }
    if (
      String(execution.mission_id) !== String(governed.mission_id) ||
      String(execution.task_id) !== String(governed.task_id) ||
      String(governed.executor_id) !== String(execution.executor_id)
    ) {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_VERIFICATION",
        `${executionId}:durable_linkage`,
      );
    }
    const expected = this.acceptanceFactsForExecution(executionId);
    // §4 — a current row claiming this execution WITHOUT a historical
    // ARTIFACT_ACCEPTED is injected authority: fail closed, never grant
    // it PASS authority merely because its fields look canonical.
    for (const row of this.store.list(ARTIFACT_ENTITY)) {
      const id = String(row.artifact_id);
      if (String(row.execution_id) === executionId && !expected.has(id)) {
        throw new IntegrityError(
          "FAIL_CLOSED_ARTIFACT_VERIFICATION",
          `${id}:no_acceptance_history`,
        );
      }
    }
    const verified: string[] = [];
    for (const id of expected.keys()) {
      // One shared seam (R1.1): immutable acceptance facts ↔ current row
      // ↔ producer identity ↔ storage ↔ retained bytes NOW.
      this.verifyAcceptedArtifact(id, execution);
      verified.push(id);
    }
    return verified;
  }

  /** R6.3 + R7.2 — the immutable acceptance facts recorded by the
   *  append-only hash-verified ARTIFACT_ACCEPTED event plane for ONE
   *  execution. Malformed history and conflicting duplicate acceptances
   *  fail closed; the set is the authority every consumer derives from. */
  private acceptanceFactsForExecution(
    executionId: string,
  ): Map<string, AcceptedArtifactFacts> {
    const expected = new Map<string, AcceptedArtifactFacts>();
    for (const ev of this.store.listEvents(ARTIFACT_ENTITY)) {
      if (
        String(ev.event_type) !== "ARTIFACT_ACCEPTED" ||
        String(
          ((ev.metadata as Record<string, unknown> | null) ?? {}).execution_id ?? "",
        ) !== executionId
      ) {
        continue;
      }
      const id = String(ev.entity_id);
      const mal = (field: string): never => {
        throw new IntegrityError(
          "FAIL_CLOSED_ARTIFACT_VERIFICATION",
          `${id}:malformed_history:${field}`,
        );
      };
      const md = ev.metadata as Record<string, unknown> | null;
      if (md === null || typeof md !== "object") mal("metadata");
      const logicalName = String(ev.new_state ?? "");
      if (!logicalName) mal("new_state");
      const producer = md!.producer_executor_id;
      if (typeof producer !== "string" || !producer) mal("producer_executor_id");
      const sha = md!.sha256;
      if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) mal("sha256");
      const size = md!.byte_size;
      if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
        mal("byte_size");
      }
      const channel = md!.channel;
      if (typeof channel !== "string" || !channel) mal("channel");
      const facts = {
        logical_name: logicalName,
        producer_executor_id: producer as string,
        sha256: sha as string,
        byte_size: size as number,
        channel: channel as string,
      };
      const prev = expected.get(id);
      if (prev) {
        if (
          prev.logical_name !== facts.logical_name ||
          prev.producer_executor_id !== facts.producer_executor_id ||
          prev.sha256 !== facts.sha256 ||
          prev.byte_size !== facts.byte_size ||
          prev.channel !== facts.channel
        ) {
          throw new IntegrityError(
            "FAIL_CLOSED_ARTIFACT_VERIFICATION",
            `${id}:conflicting_history`,
          );
        }
        continue;
      }
      expected.set(id, facts);
    }
    return expected;
  }

  /**
   * F2 R1.1 — the ONE shared consumption authority: proves a single
   * artifact is bound end-to-end as
   *
   *   ARTIFACT_ACCEPTED immutable history
   *   ↔ current ART row
   *   ↔ producer durable identity (execution + governed task)
   *   ↔ storage contract
   *   ↔ retained CAS bytes verified NOW
   *
   * Terminal validation and F2 consumption call the same seam — a row
   * coherently rewritten to different (still CAS-valid) bytes fails on
   * history; a row without acceptance history never qualifies.
   */
  private verifyAcceptedArtifact(
    artifactId: string,
    execution: Record<string, unknown>,
  ): Record<string, unknown> {
    const id = artifactId;
    const fail = (reason: string): never => {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_VERIFICATION",
        `${id}:${reason}`,
      );
    };
    const facts = this.acceptanceFactsForExecution(
      String(execution.execution_id),
    ).get(id);
    if (!facts) fail("no_acceptance_history");
    const row = this.store.tryGet(ARTIFACT_ENTITY, id) as Record<
      string,
      unknown
    > | null;
    if (!row) fail("missing");
    if (String(row!.artifact_id) !== id) fail("artifact_id_field");
    if (String(row!.logical_name) !== facts!.logical_name) fail("logical_name");
    if (String(row!.producer_executor_id) !== facts!.producer_executor_id) {
      fail("producer_executor_id");
    }
    if (String(row!.sha256) !== facts!.sha256) fail("sha256");
    if (Number(row!.byte_size) !== facts!.byte_size) fail("byte_size");
    if (String(row!.ingested_via) !== facts!.channel) fail("ingested_via");
    this.verifyCanonicalRowShape(
      row!,
      execution,
      String(execution.execution_id),
    );
    return row!;
  }

  /**
   * The canonical-shape proof shared by terminal validation and F2
   * consumption: contract, state, deterministic id, full execution/
   * governed linkage, storage contract, and the retained CAS bytes
   * verified NOW via the open-object-bound read primitive.
   */
  private verifyCanonicalRowShape(
    row: Record<string, unknown>,
    execution: Record<string, unknown>,
    executionId: string,
  ): void {
    const id = String(row.artifact_id);
    const fail = (reason: string): never => {
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_VERIFICATION", `${id}:${reason}`);
    };
    const sha = String(row.sha256 ?? "");
    if (String(row.execution_id) !== executionId) fail("execution_id");
    if (String(row.contract ?? "") !== ARTIFACT_CONTRACT) fail("contract");
    if (String(row.state ?? "") !== "ACCEPTED") fail("state");
    if (id !== canonicalArtifactId(executionId, String(row.logical_name))) {
      fail("artifact_id");
    }
    if (String(row.mission_id) !== String(execution.mission_id)) fail("mission_id");
    if (String(row.task_id) !== String(execution.task_id)) fail("task_id");
    if (String(row.governed_task_id) !== String(execution.governed_task_id)) {
      fail("governed_task_id");
    }
    if (String(row.producer_executor_id) !== String(execution.executor_id)) {
      fail("producer_executor_id");
    }
    if (
      typeof row.byte_size !== "number" ||
      !Number.isInteger(row.byte_size) ||
      row.byte_size < 0
    ) {
      fail("byte_size");
    }
    const storage = row.storage as Record<string, unknown> | undefined;
    if (String(storage?.kind ?? "") !== "PAIR_ARTIFACT_CAS") fail("storage.kind");
    if (String(storage?.sha256 ?? "") !== sha) fail("storage.sha256");
    if (String(storage?.ref ?? "") !== `blobs/${sha}`) fail("storage.ref");
    // R4 open-object-bound retained proof: regular opened object,
    // digest == row sha, materialized length == declared byte_size.
    const blob = this.readCasBlob(path.join(this.opts.blobDir, sha));
    if (blob === null || blob.sha256 !== sha || blob.bytes.length !== row.byte_size) {
      fail("retained_bytes");
    }
  }

  /**
   * F2 §6–§7 — the narrow consumption-time authority: prove ONE artifact
   * is fully canonical AND bound to the claimed producer execution/task/
   * mission RIGHT NOW. The caller supplies the EXPECTED producer binding
   * (from an already-pinned dependency contract / known-durable context)
   * — the mutable artifact row is never consulted for what to trust.
   * Historical acceptance facts, durable linkage, current row identity,
   * storage contract and retained CAS bytes are all re-verified NOW.
   */
  verifyArtifactForConsumption(
    artifactId: string,
    expected: {
      execution_id: string;
      mission_id?: string;
      task_id?: string;
      governed_task_id?: string;
      producer_executor_id?: string;
      sha256?: string;
      byte_size?: number;
      logical_name?: string;
    },
  ): Record<string, unknown> {
    const fail = (reason: string): never => {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_VERIFICATION",
        `${artifactId}:${reason}`,
      );
    };
    const execution = this.store.tryGet(
      "executor_execution",
      expected.execution_id,
    ) as Record<string, unknown> | null;
    if (!execution) {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_EXECUTION_UNKNOWN",
        expected.execution_id,
      );
    }
    const governed = this.store.tryGet(
      "governed_task",
      String(execution.governed_task_id),
    ) as Record<string, unknown> | null;
    if (
      !governed ||
      String(execution.mission_id) !== String(governed.mission_id) ||
      String(execution.task_id) !== String(governed.task_id) ||
      String(governed.executor_id) !== String(execution.executor_id)
    ) {
      fail("durable_linkage");
    }
    const row = this.verifyAcceptedArtifact(artifactId, execution);
    if (String(row.execution_id) !== expected.execution_id) fail("execution_id");
    if (
      expected.mission_id !== undefined &&
      String(row.mission_id) !== expected.mission_id
    ) {
      fail("mission_id");
    }
    if (
      expected.task_id !== undefined &&
      String(row.task_id) !== expected.task_id
    ) {
      fail("task_id");
    }
    if (
      expected.governed_task_id !== undefined &&
      String(row.governed_task_id) !== expected.governed_task_id
    ) {
      fail("governed_task_id");
    }
    if (
      expected.producer_executor_id !== undefined &&
      String(row.producer_executor_id) !== expected.producer_executor_id
    ) {
      fail("producer_executor_id");
    }
    if (
      expected.sha256 !== undefined &&
      String(row.sha256) !== expected.sha256
    ) {
      fail("sha256");
    }
    if (
      expected.byte_size !== undefined &&
      Number(row.byte_size) !== expected.byte_size
    ) {
      fail("byte_size");
    }
    if (
      expected.logical_name !== undefined &&
      String(row.logical_name) !== expected.logical_name
    ) {
      fail("logical_name");
    }
    return row;
  }

  /** F2 R1.2 — verified retained bytes for a canonical artifact. The
   *  caller supplies the pinned expected producer binding — artifact id,
   *  producer execution/task/governed/mission/executor + logical name +
   *  sha256 + byte_size — and the returned bytes are the exact retained
   *  CAS bytes only after the pinned expectations verify against the
   *  F1 acceptance history AND the current row AND the open-object CAS
   *  read. The mutable row never defines the expected authority. */
  readForConsumption(
    artifactId: string,
    expected: {
      execution_id: string;
      mission_id?: string;
      task_id?: string;
      governed_task_id?: string;
      producer_executor_id?: string;
      logical_name?: string;
      sha256?: string;
      byte_size?: number;
    },
  ): {
    artifact: Record<string, unknown>;
    bytes: Buffer;
  } {
    const artifact = this.verifyArtifactForConsumption(artifactId, expected);
    const sha = String(artifact.sha256);
    const blob = this.readCasBlob(path.join(this.opts.blobDir, sha));
    if (
      blob === null ||
      blob.sha256 !== sha ||
      blob.bytes.length !== Number(artifact.byte_size)
    ) {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_VERIFICATION",
        `${artifactId}:retained_bytes`,
      );
    }
    return { artifact, bytes: blob.bytes };
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
    // R2.4 — the complete durable chain must agree: the governed task's
    // executor of record == the execution's executor == the claimed
    // producer. A durable contradiction between governance rows fails
    // closed even when the claimed producer matches the execution row.
    if (String(governed.executor_id ?? "") !== String(execution.executor_id)) {
      throw new IntegrityError(
        "FAIL_CLOSED_ARTIFACT_LINKAGE",
        `${executionId}:governed executor ${String(governed.executor_id)} != ${String(execution.executor_id)}`,
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
    // R2.1 — containment and byte materialization are bound to ONE
    // opened file object (open-once + /proc/self/fd realpath +
    // fstat + bounded read on the same fd). A parent symlink swap
    // after open cannot redirect the already-bound object.
    const br = secureReadContained(source.path, this.maxBytes, identity.allowed_paths);
    if (br.kind === "too_large") {
      this.rejectMeta(ev.mission_id, ev, "ARTIFACT_TOO_LARGE", `size=${br.size}`);
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_TOO_LARGE", `size=${br.size}`);
    }
    if (br.kind === "outside") {
      this.rejectMeta(ev.mission_id, ev, "ARTIFACT_PATH_OUTSIDE", source.path);
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_PATH_OUTSIDE", source.path);
    }
    if (br.kind === "symlink") {
      this.rejectMeta(ev.mission_id, ev, "ARTIFACT_SYMLINK", source.path);
      throw new IntegrityError("FAIL_CLOSED_ARTIFACT_SYMLINK", source.path);
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

  /** R2.3 — canonical prior proof: a row may satisfy idempotent replay
   *  only when it is a VALID F1 authority — correct contract, every
   *  identity dimension agreeing with the durable producer chain, the
   *  deterministic ART id, the normalized logical name, ACCEPTED state,
   *  matching byte_size, CAS storage bound to the row sha, AND the
   *  retained blob actually verifying to the incoming digest. A
   *  same-id/same-sha legacy or malformed row is never elevated. */
  private isCanonicalPrior(
    prior: Record<string, unknown>,
    p: PreparedArtifact,
    identity: ProducerIdentity,
    args: { execution_id: string; producer_executor_id: string },
  ): boolean {
    if (String(prior.contract ?? "") !== ARTIFACT_CONTRACT) return false;
    if (String(prior.artifact_id) !== p.artifact_id) return false;
    if (String(prior.execution_id) !== args.execution_id) return false;
    if (String(prior.governed_task_id) !== identity.governed_task_id) return false;
    if (String(prior.mission_id) !== identity.mission_id) return false;
    if (String(prior.task_id) !== identity.task_id) return false;
    if (String(prior.producer_executor_id) !== args.producer_executor_id) return false;
    if (String(prior.logical_name) !== p.logical_name) return false;
    if (String(prior.state) !== "ACCEPTED") return false;
    if (Number(prior.byte_size) !== p.bytes.length) return false;
    const storage = prior.storage as Record<string, unknown> | undefined;
    if (!storage || String(storage.kind ?? "") !== "PAIR_ARTIFACT_CAS") return false;
    if (String(storage.sha256 ?? "") !== p.sha256) return false;
    // R3.2 — the canonical storage contract is exact: the logical ref
    // must be the content-addressed `blobs/<sha>` — no alternate path,
    // no traversal, no missing ref.
    if (String(storage.ref ?? "") !== `blobs/${p.sha256}`) return false;
    // …and the retained object must verify as a canonical CAS blob:
    // ONE open-object read (O_NOFOLLOW → same-fd regular/bound/read/
    // post-fstat) — never lstat→reopen, never a symlink.
    const blobPath = path.join(this.opts.blobDir, p.sha256);
    const blob = this.readCasBlob(blobPath);
    return blob !== null && blob.sha256 === p.sha256;
  }

  /** R4.1 — the ONE canonical CAS read primitive: open once with
   *  O_RDONLY|O_NOFOLLOW, fstat the SAME fd (regular file), bound,
   *  read the SAME fd, post-read fstat stability, then hash those
   *  exact bytes. The object proven regular IS the object hashed —
   *  lstat→reopen is a TOCTOU and a final-component symlink always
   *  fails closed. */
  private readCasBlob(dest: string): { bytes: Buffer; sha256: string } | null {
    const r = secureReadContained(dest, this.maxBytes, [this.opts.blobDir]);
    if (r.kind !== "ok") return null;
    return { bytes: r.bytes, sha256: sha256Hex(r.bytes) };
  }

  /** R3.1/R2.6 — the ONE directory-durability barrier: parent-dir
   *  fsync so a power-loss cannot drop a committed blob name. ONLY
   *  documented unsupported-platform/fs codes degrade; every other
   *  failure (EIO, EPERM, ...) fails closed — an uncommitted directory
   *  entry must never masquerade as durable. */
  private ensureBlobDirectoryDurable(dir: string, sha256: string): void {
    try {
      const dfd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") {
        throw new IntegrityError(
          "FAIL_CLOSED_ARTIFACT_BLOB_DURABILITY",
          `${sha256}:${String(e)}`,
        );
      }
      /* documented unsupported dir-fsync platform/fs — fallback */
    }
  }

  private persistBlob(sha256: string, bytes: Buffer): void {
    const dir = this.opts.blobDir;
    const dest = path.join(dir, sha256);
    // R4.1 — reuse proof through the SAME open-object primitive: a
    // matching digest on the OPENED regular file may be reused; a
    // symlink or a torn/mismatched object falls through to rewrite
    // (rename atomically replaces whatever sat at dest).
    const existing = this.readCasBlob(dest);
    if (existing !== null && existing.sha256 === sha256) {
      // R3.1 — a reused blob backing a NEW authority mint must still
      // carry a successful durability barrier: a previous failed
      // dir-fsync cannot be bypassed just because the renamed bytes
      // remain visible. Never unlink — the blob may already back
      // another canonical artifact; re-prove the barrier instead.
      this.ensureBlobDirectoryDurable(dir, sha256);
      return;
    }
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
    // R1.9/R3.1 — commit the directory entry through the same barrier.
    this.ensureBlobDirectoryDurable(dir, sha256);
    const post = this.readCasBlob(dest);
    if (post === null || post.sha256 !== sha256) {
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
