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

/** True when `candidate` is `root` itself or strictly inside it (resolved). */
export function pathWithin(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(resolvedRoot + path.sep)
  );
}
