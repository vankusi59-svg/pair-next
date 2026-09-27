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

/** True when `candidate` is `root` itself or strictly inside it (resolved). */
export function pathWithin(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(resolvedRoot + path.sep)
  );
}
