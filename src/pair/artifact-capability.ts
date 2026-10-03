/**
 * F1 §6 — execution-scoped artifact-upload capability.
 *
 * The artifact master secret (PAIR_ARTIFACT_UPLOAD_TOKEN, falling back to
 * the broker master) never leaves the server. At dispatch the executor
 * mints a scoped capability bound to the exact governed context —
 * mission_id + task_id + governed_task_id + execution_id + producer
 * executor_id — integrity-protected by HMAC-SHA256 keyed on the master
 * secret. The remote worker presents only this capability via
 * `x-artifact-capability`; /api/outbox verifies the signature AND that
 * every claim matches canonical state (the execution row and its
 * task/mission/executor linkage) before canonical ingest runs.
 *
 * A generic PAIR_OUTBOX_TOKEN upload keeps working as transport/storage
 * compatibility ONLY — it never mints canonical artifact authority.
 *
 * The capability carries no secret value and is never persisted in the
 * PairEvidenceStore.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { utcnow } from "./canonical.js";
import { registerSensitiveMaterial } from "./sanitizer.js";

export interface ArtifactCapabilityClaims {
  mission_id: string;
  task_id: string;
  governed_task_id: string;
  execution_id: string;
  executor_id: string;
  issued_at: string;
}

const KEY_PREFIX = "pair.artifact-capability.v1";

function sign(masterSecret: string, payloadB64: string): string {
  return createHmac("sha256", `${KEY_PREFIX}:${masterSecret}`).update(payloadB64).digest("base64url");
}

export function mintArtifactCapability(
  masterSecret: string,
  claims: {
    mission_id: string;
    task_id: string;
    governed_task_id: string;
    execution_id: string;
    executor_id: string;
    issued_at?: string;
  },
): string {
  const payload: ArtifactCapabilityClaims = {
    mission_id: String(claims.mission_id),
    task_id: String(claims.task_id),
    governed_task_id: String(claims.governed_task_id),
    execution_id: String(claims.execution_id),
    executor_id: String(claims.executor_id),
    issued_at: claims.issued_at ?? utcnow(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const token = `acap1.${payloadB64}.${sign(masterSecret, payloadB64)}`;
  // Both the minted capability and the master secret are registered as
  // never-canonical material — a remote worker echoing either sees it
  // redacted before persistence.
  registerSensitiveMaterial(token);
  registerSensitiveMaterial(masterSecret);
  return token;
}

export function verifyArtifactCapability(
  masterSecret: string,
  token: string,
): ArtifactCapabilityClaims | null {
  const m = /^acap1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return null;
  const expected = sign(masterSecret, m[1]);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(m[2], "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    typeof claims.mission_id !== "string" ||
    typeof claims.task_id !== "string" ||
    typeof claims.governed_task_id !== "string" ||
    typeof claims.execution_id !== "string" ||
    typeof claims.executor_id !== "string"
  ) {
    return null;
  }
  return {
    mission_id: claims.mission_id,
    task_id: claims.task_id,
    governed_task_id: claims.governed_task_id,
    execution_id: claims.execution_id,
    executor_id: claims.executor_id,
    issued_at: String(claims.issued_at ?? ""),
  };
}

/** Server/executor must agree on the same master-secret resolution. */
export function artifactCapabilityMasterFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.PAIR_ARTIFACT_UPLOAD_TOKEN || env.PAIR_BROKER_TOKEN || undefined;
}
