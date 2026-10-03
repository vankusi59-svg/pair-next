/**
 * Canonical serialization / digest primitives ported from PAIR donor
 * standalone_core/persistence.py (canonical_json + sha256 digest semantics).
 *
 * canonical_json: sorted keys, `(",", ":")` separators, ensure_ascii=False.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { IntegrityError } from "./errors.js";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value) as JsonValue, undefined, 0).replace(
    /[\u2028\u2029]/g,
    (ch) => (ch === " " ? "\\u2028" : "\\u2029"),
  );
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) {
        continue;
      }
      out[key] = sortValue(v);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("NON_FINITE_NUMBER_IN_CANONICAL_JSON");
  }
  return value;
}

export function digest(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

/** Immutable identity of an activated plan's complete task manifest —
 *  pinned inside MISSION_PLAN_COMMITTED at commit time. Task order is
 *  significant (it corresponds to task.order). */
export function planManifestDigest(f: {
  mission_id: string;
  plan_id: string;
  revision: number;
  task_ids: string[];
}): string {
  return digest({
    plan_manifest: 1,
    mission_id: f.mission_id,
    plan_id: f.plan_id,
    revision: f.revision,
    task_ids: [...f.task_ids],
  });
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(filePath: string): string {
  return sha256Hex(fs.readFileSync(filePath));
}

/** F1/R5 — the ONE canonical stat-first bounded file authority used by
 *  every governed byte seam (delivery pins/snapshots/transport, artifact
 *  ingest). NEVER performs an unbounded full read: stat proves
 *  `size <= maxBytes` FIRST; a successful read additionally proves
 *  `bytes.length === stat size` (no mid-read growth) and the sha256 is
 *  computed over THOSE exact materialized bytes. */
export type BoundedFileResult =
  | { kind: "ok"; size: number; bytes: Buffer; sha256: string }
  | { kind: "too_large"; size: number }
  | { kind: "unresolved" };

export function boundedFileSha256(p: string, maxBytes: number): BoundedFileResult {
  let size: number;
  try {
    size = fs.statSync(p).size;
  } catch {
    return { kind: "unresolved" };
  }
  if (size > maxBytes) return { kind: "too_large", size };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(p);
  } catch {
    return { kind: "unresolved" };
  }
  if (bytes.length !== size) return { kind: "unresolved" };
  return { kind: "ok", size, bytes, sha256: sha256Hex(bytes) };
}

/** F1 — deterministic canonical artifact identity: the same producer
 *  execution + logical name always resolves the same ART_* id, so an
 *  idempotent replay converges instead of minting duplicate authority. */
export function canonicalArtifactId(executionId: string, logicalName: string): string {
  return `ART_${digest({ execution_id: executionId, logical_name: logicalName }).slice(0, 32).toUpperCase()}`;
}

/** R2.5 — ONE canonical compat-naming rule shared by the outbox
 *  materialization writer and the delivery resolver. A logical artifact
 *  basename is deterministically mapped to its compat filename — two
 *  distinct logical names MAY share one compat basename, but their
 *  full compat path stays injective via the artifact-id fragment. */
export function compatOutboxBasename(logicalName: string): string {
  return path.basename(String(logicalName)).replace(/[^\w.\-]/g, "_");
}

/** R2.1 — secure contained file read: binds containment proof and byte
 *  materialization to the SAME opened file object. `realpath(check) →
 *  reopen(path)` is a TOCTOU — a parent symlink or directory entry can
 *  be swapped between resolution and read. Here the fd is opened once
 *  (O_NOFOLLOW on the final component), the OPENED object's real path
 *  is resolved through /proc/self/fd (Linux — fails closed where
 *  unavailable), proven under a governed allowed root, fstat'd, bounded,
 *  read and length-verified — all on that one fd. Parent-symlink swaps
 *  after open cannot redirect the already-bound file object. */
export type SecureContainedReadResult =
  | { kind: "ok"; size: number; bytes: Buffer }
  | { kind: "too_large"; size: number }
  | { kind: "unresolved" }
  | { kind: "outside" }
  | { kind: "symlink" };

export function secureReadContained(
  p: string,
  maxBytes: number,
  allowedRoots: string[],
): SecureContainedReadResult {
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") return { kind: "symlink" };
    return { kind: "unresolved" };
  }
  try {
    const fdPath = `/proc/self/fd/${fd}`;
    if (!fs.existsSync("/proc/self/fd")) {
      // No platform seam to prove opened-object containment — fail
      // closed rather than fall back to a racy pathname check.
      return { kind: "unresolved" };
    }
    let real: string;
    try {
      real = fs.realpathSync(fdPath);
    } catch {
      return { kind: "unresolved" };
    }
    const inside = allowedRoots.some((ap) => {
      try {
        return pathWithin(real, fs.realpathSync(ap));
      } catch {
        return false;
      }
    });
    if (!inside) return { kind: "outside" };
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) return { kind: "unresolved" };
    if (st.size > BigInt(maxBytes)) {
      return { kind: "too_large", size: Number(st.size) };
    }
    const size = Number(st.size);
    const bytes = Buffer.alloc(size);
    const read = fs.readSync(fd, bytes, 0, size, 0);
    if (read !== size) return { kind: "unresolved" };
    // R3.3 — re-fstat the SAME fd after the read: a file that grew or
    // was mutated during materialization must never silently pass.
    // dev/ino pin file identity; size/mtimeNs/ctimeNs pin content
    // mutation wherever the filesystem exposes them.
    const st2 = fs.fstatSync(fd, { bigint: true });
    if (
      st2.dev !== st.dev ||
      st2.ino !== st.ino ||
      st2.size !== st.size ||
      st2.mtimeNs !== st.mtimeNs ||
      st2.ctimeNs !== st.ctimeNs
    ) {
      return { kind: "unresolved" };
    }
    return { kind: "ok", size, bytes };
  } finally {
    fs.closeSync(fd);
  }
}

export function utcnow(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/** Deterministic worker execution identity: EXE_ + sha256(canonical ids)[:32]. */
export function workerExecutionId(executorId: string, governedTaskId: string): string {
  return `EXE_${digest({ executor_id: executorId, governed_task_id: governedTaskId }).slice(0, 32)}`;
}

/** Atomic JSON write: write tmp + rename (donor _atomic_write semantics). */
export function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${ulid()}`;
  fs.writeFileSync(tmp, canonicalJson(value) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

export function readJsonFile<T = unknown>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function appendJsonl(filePath: string, entry: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, canonicalJson(entry) + "\n", "utf8");
}

/**
 * R6 — the single canonical workspace representation: an absolute,
 * resolved, normalized path. Every accepted workspace string flows through
 * this helper BEFORE digests/persistence so the pinned authority is
 * byte-for-byte identical at preview, confirm, mission creation, and
 * authorizedRoots evaluation. Invalid input fails closed — never silently
 * accepted.
 */
export function canonicalWorkspacePath(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new IntegrityError(
      "FAIL_CLOSED_WORKSPACE_AUTHORITY_INVALID",
      `workspace authority must be a non-empty string, got ${JSON.stringify(raw)}`,
    );
  }
  return path.resolve(raw);
}

/** True when `w` is already in canonical form (byte-for-byte). */
export function isCanonicalWorkspacePath(w: unknown): w is string {
  return typeof w === "string" && w.trim() !== "" && path.resolve(w) === w;
}

/**
 * R7 — the canonical risk vocabulary + the single risk normalization seam.
 * Omitted/null resolves to the system default "HIGH" BEFORE digests and
 * persistence, so previewed authority == committed authority. Malformed
 * values fail closed rather than being silently reinterpreted.
 */
export const CANONICAL_RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const CANONICAL_RISK_DEFAULT = "HIGH";

export function canonicalRiskCeiling(raw: unknown): string {
  if (raw == null) return CANONICAL_RISK_DEFAULT;
  const v = String(raw);
  if (!(CANONICAL_RISK_LEVELS as readonly string[]).includes(v)) {
    throw new IntegrityError(
      "FAIL_CLOSED_RISK_CEILING_INVALID",
      `risk_ceiling must be one of ${CANONICAL_RISK_LEVELS.join("/")}, got ${JSON.stringify(raw)}`,
    );
  }
  return v;
}

/** True when `v` is an explicit canonical risk level (not the defaulted one). */
export function isCanonicalRiskCeiling(v: unknown): v is string {
  return typeof v === "string" && (CANONICAL_RISK_LEVELS as readonly string[]).includes(v);
}

/** True when `candidate` is `root` itself or strictly inside it (resolved). */
export function pathWithin(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(resolvedRoot + path.sep)
  );
}
